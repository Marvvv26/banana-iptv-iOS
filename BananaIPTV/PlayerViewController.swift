import UIKit
import MobileVLCKit

/// Full-screen player. Same payload as the Fire TV player:
/// {type, index, start, ua, buffer, subs, acct, profile, items:[{key,id,title,sub,url,alt,epg}]}
final class PlayerViewController: UIViewController, VLCMediaPlayerDelegate, UIGestureRecognizerDelegate {
    struct Item { var key = "", id = "", title = "", sub = "", url = "", alt = "", epg = "" }

    private(set) var ok = false
    private var type = "live", index = 0, startAt: Int64 = 0, ua = "", bufferMs = 3000, subsPref = "off", acct = "", profile = ""
    private var items: [Item] = []
    private let onClose: () -> Void

    private let player = VLCMediaPlayer()
    private let vlcQueue = DispatchQueue(label: "uk.banana.iptv.vlc")   // slow libVLC calls stay off the screen thread
    private var gen = 0
    private var usingAlt = false, retries = 0
    private var lastTime: Int64 = -1, lastProgress = Date(), started = Date()
    private var userPaused = false, closing = false, failed = false, subsApplied = false, dragging = false
    private var lastSave = Date()
    private var tick: Timer?, hideTimer: Timer?
    private var cropPtr: UnsafeMutablePointer<CChar>?

    // UI
    private let video = UIView()
    private let overlay = UIView()
    private let titleLabel = UILabel(), subLabel = UILabel(), epgLabel = UILabel(), msgLabel = UILabel()
    private let timeLabel = UILabel(), durLabel = UILabel()
    private let slider = UISlider()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let playBtn = UIButton(type: .system), prevBtn = UIButton(type: .system), nextBtn = UIButton(type: .system)
    private let closeBtn = UIButton(type: .system), ccBtn = UIButton(type: .system), audioBtn = UIButton(type: .system), vlcBtn = UIButton(type: .system)

    private let prefs = UserDefaults.standard
    private var isLive: Bool { type == "live" }
    private var cur: Item { items[index] }

    init(json: String, onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        ok = parse(json)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    private func parse(_ json: String) -> Bool {
        guard let d = json.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return false }
        type = o["type"] as? String ?? "live"
        index = (o["index"] as? NSNumber)?.intValue ?? 0
        startAt = (o["start"] as? NSNumber)?.int64Value ?? 0
        ua = o["ua"] as? String ?? ""
        bufferMs = max(500, min(30000, (o["buffer"] as? NSNumber)?.intValue ?? 3000))
        subsPref = o["subs"] as? String ?? "off"
        acct = o["acct"] as? String ?? ""
        profile = o["profile"] as? String ?? ""
        if profile.range(of: "^[A-Za-z0-9]{0,20}\\|?$", options: .regularExpression) == nil { profile = "" }
        for j in (o["items"] as? [[String: Any]]) ?? [] {
            var it = Item()
            it.key = j["key"] as? String ?? ""; it.id = j["id"] as? String ?? (j["id"] as? NSNumber)?.stringValue ?? ""
            it.title = j["title"] as? String ?? ""; it.sub = j["sub"] as? String ?? ""
            it.url = j["url"] as? String ?? ""; it.alt = j["alt"] as? String ?? ""; it.epg = j["epg"] as? String ?? ""
            if Self.isHttp(it.url) { items.append(it) }
        }
        index = max(0, min(index, items.count - 1))
        return !items.isEmpty
    }
    private static func isHttp(_ s: String) -> Bool { s.hasPrefix("http://") || s.hasPrefix("https://") }

    // MARK: - lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        buildUi()
        player.delegate = self
        player.drawable = video
        start()
        tick = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.onTick() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func close() {
        guard !closing else { return }
        closing = true
        saveResume()
        tick?.invalidate(); hideTimer?.invalidate()
        player.delegate = nil
        let p = player, crop = cropPtr
        cropPtr = nil
        vlcQueue.async {                      // stopping can block on a stuck stream
            p.stop()
            if let c = crop { free(c) }
        }
        dismiss(animated: false) { [onClose] in onClose() }
    }

    // MARK: - playback

    private func start() {
        failed = false; msgLabel.isHidden = true
        subsApplied = false; lastTime = -1; lastProgress = Date(); started = Date()
        let it = cur
        let u = (usingAlt && Self.isHttp(it.alt)) ? it.alt : it.url
        guard let url = URL(string: u) else { return fail("This stream link isn't valid.") }
        let m = VLCMedia(url: url)
        m.addOption(":network-caching=\(bufferMs)")
        m.addOption(":http-reconnect")
        if !ua.isEmpty { m.addOption(":http-user-agent=\(ua)") }
        if !isLive && startAt > 0 { m.addOption(":start-time=\(Double(startAt) / 1000.0)") }
        gen += 1
        let g = gen, p = player
        vlcQueue.async { [weak self] in
            guard let self = self else { return }
            var stale = false
            DispatchQueue.main.sync { stale = (g != self.gen || self.closing) }
            if stale { return }
            p.media = m
            p.play()
        }
        titleLabel.text = it.title
        subLabel.text = isLive ? "\(it.sub)" : it.sub
        epgLabel.text = ""
        spinner.startAnimating()
        prevBtn.isHidden = items.count < 2
        nextBtn.isHidden = items.count < 2
        slider.isHidden = isLive; timeLabel.isHidden = isLive; durLabel.isHidden = isLive
        if isLive {
            PlayerStore.shared.addRecentLive(profile + it.id)
            loadEpg(it)
        }
        showOverlay(autoHide: true)
    }

    private func switchTo(_ i: Int) {
        guard !items.isEmpty else { return }
        saveResume()
        index = (i + items.count) % items.count
        usingAlt = false; retries = 0; startAt = 0; userPaused = false
        start()
    }

    private func retry() {
        if !isLive && lastTime > 0 { startAt = lastTime }
        retries += 1
        if retries >= 2 && Self.isHttp(cur.alt) && !usingAlt { usingAlt = true }
        start()
    }

    private func onTick() {
        guard !closing else { return }
        let st = player.state
        let t = Int64(player.time.intValue)
        if t != lastTime && player.isPlaying { lastTime = t; lastProgress = Date() }
        let stalled = !userPaused && Date().timeIntervalSince(lastProgress) > 1.5
        if !failed { stalled || st == .opening || st == .buffering ? spinner.startAnimating() : spinner.stopAnimating() }
        if failed { return }

        if st == .error { return handleFailure() }
        if st == .ended {
            if !isLive && type == "series" && index < items.count - 1 { PlayerStore.shared.saveResume(key: cur.key, posMs: t, durMs: duration()); return switchTo(index + 1) }
            if isLive { return handleFailure() }
            return close()
        }
        // Watchdog: nothing has moved for a while (frozen stream) -> reconnect.
        let limit: TimeInterval = lastTime < 0 ? 20 : 12
        if !userPaused && Date().timeIntervalSince(lastProgress) > limit { handleFailure() ; return }

        if !isLive && !dragging {
            let d = duration()
            if d > 0 { slider.value = Float(Double(max(0, t)) / Double(d)) }
            timeLabel.text = Self.fmt(t); durLabel.text = d > 0 ? Self.fmt(d) : ""
        }
        if !subsApplied && player.isPlaying && Date().timeIntervalSince(started) > 1.5 { applySubsPref() }
        if Date().timeIntervalSince(lastSave) > 15 { saveResume() }
        playBtn.setImage(UIImage(systemName: player.isPlaying ? "pause.fill" : "play.fill"), for: .normal)
    }

    private func handleFailure() {
        if retries < 3 { retry(); return }
        fail(isLive ? "This channel isn't playing right now." : "This video won't play right now.")
        checkConnections()
    }

    private func fail(_ msg: String) {
        failed = true
        spinner.stopAnimating()
        msgLabel.text = msg + "\nTap ↻ to try again, or open it in VLC."
        msgLabel.isHidden = false
        showOverlay(autoHide: false)
    }

    /// If the login's connections are all in use (often VLC or another device), say so.
    private func checkConnections() {
        guard let u = URL(string: acct), Self.isHttp(acct) else { return }
        var r = URLRequest(url: u, timeoutInterval: 12)
        r.setValue("BananaIPTV/1.0 (iPhone)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: r) { [weak self] data, _, _ in
            guard let data = data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let ui = o["user_info"] as? [String: Any] else { return }
            let n = { (k: String) -> Int in (ui[k] as? NSNumber)?.intValue ?? Int("\(ui[k] ?? "")") ?? 0 }
            let active = n("active_cons"), maxC = n("max_connections")
            guard maxC > 0 && active >= maxC else { return }
            DispatchQueue.main.async {
                guard let self = self, self.failed else { return }
                self.msgLabel.text = "Your login is already using \(active) of \(maxC) connection\(maxC == 1 ? "" : "s").\nClose VLC or the app on your other device, then tap ↻."
            }
        }.resume()
    }

    private func duration() -> Int64 { Int64(player.media?.length.intValue ?? 0) }

    private func saveResume() {
        lastSave = Date()
        guard !isLive, !cur.key.isEmpty, lastTime > 0 else { return }
        PlayerStore.shared.saveResume(key: cur.key, posMs: lastTime, durMs: duration())
    }

    // MARK: - subtitles & audio

    private static func languageWord(_ name: String) -> String {
        let w = name.lowercased().components(separatedBy: CharacterSet.letters.inverted).first(where: { $0.count > 1 && $0 != "track" })
        return w ?? name.lowercased()
    }

    private func subTracks() -> [(Int32, String)] {
        let names = (player.videoSubTitlesNames as? [String]) ?? []
        let ids = (player.videoSubTitlesIndexes as? [NSNumber]) ?? []
        return zip(ids, names).map { ($0.int32Value, $1) }.filter { $0.0 >= 0 }
    }

    private func applySubsPref() {
        subsApplied = true
        let on = prefs.object(forKey: "banana.subsOn") as? Bool ?? (subsPref == "on")
        guard on else { return }
        let lang = prefs.string(forKey: "banana.subsLang") ?? "english"
        let tr = subTracks()
        if let pick = tr.first(where: { Self.languageWord($0.1) == lang }) ?? tr.first {
            player.currentVideoSubTitleIndex = pick.0
        }
    }

    @objc private func pickSubs() {
        let tr = subTracks()
        let a = UIAlertController(title: "Subtitles", message: tr.isEmpty ? "This stream has no subtitles." : nil, preferredStyle: .actionSheet)
        a.addAction(UIAlertAction(title: (player.currentVideoSubTitleIndex < 0 ? "✓ " : "") + "Off", style: .default) { [weak self] _ in
            self?.player.currentVideoSubTitleIndex = -1
            self?.prefs.set(false, forKey: "banana.subsOn")
        })
        for (id, name) in tr {
            a.addAction(UIAlertAction(title: (player.currentVideoSubTitleIndex == id ? "✓ " : "") + name, style: .default) { [weak self] _ in
                self?.player.currentVideoSubTitleIndex = id
                self?.prefs.set(true, forKey: "banana.subsOn")
                self?.prefs.set(Self.languageWord(name), forKey: "banana.subsLang")
            })
        }
        present(sheet: a, from: ccBtn)
    }

    @objc private func pickAudio() {
        let names = (player.audioTrackNames as? [String]) ?? []
        let ids = (player.audioTrackIndexes as? [NSNumber]) ?? []
        let tr = zip(ids, names).filter { $0.0.int32Value >= 0 }
        let a = UIAlertController(title: "Audio", message: tr.isEmpty ? "Only one audio track." : nil, preferredStyle: .actionSheet)
        for (id, name) in tr {
            a.addAction(UIAlertAction(title: (player.currentAudioTrackIndex == id.int32Value ? "✓ " : "") + name, style: .default) { [weak self] _ in
                self?.player.currentAudioTrackIndex = id.int32Value
            })
        }
        present(sheet: a, from: audioBtn)
    }

    private func present(sheet a: UIAlertController, from v: UIView) {
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        a.popoverPresentationController?.sourceView = v
        a.popoverPresentationController?.sourceRect = v.bounds
        hideTimer?.invalidate()
        present(a, animated: true)
    }

    // MARK: - live TV guide line

    private func loadEpg(_ it: Item) {
        guard Self.isHttp(it.epg), let u = URL(string: it.epg) else { return }
        let want = it.id
        var r = URLRequest(url: u, timeoutInterval: 15)
        r.setValue("BananaIPTV/1.0 (iPhone)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: r) { [weak self] data, _, _ in
            guard let data = data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let l = o["epg_listings"] as? [[String: Any]] else { return }
            let b64 = { (s: Any?) -> String in
                guard let s = s as? String, let d = Data(base64Encoded: s) else { return "" }
                return String(data: d, encoding: .utf8) ?? ""
            }
            let num = { (v: Any?) -> Double in (v as? NSNumber)?.doubleValue ?? Double("\(v ?? "")") ?? 0 }
            let now = Date().timeIntervalSince1970
            let progs = l.map { (s: num($0["start_timestamp"]), e: num($0["stop_timestamp"]), t: b64($0["title"])) }.sorted { $0.s < $1.s }
            guard let i = progs.firstIndex(where: { $0.s <= now && $0.e > now }) else { return }
            let f = DateFormatter(); f.dateFormat = "HH:mm"
            var line = "Now  \(f.string(from: Date(timeIntervalSince1970: progs[i].s)))  \(progs[i].t)"
            if i + 1 < progs.count { line += "\nNext  \(f.string(from: Date(timeIntervalSince1970: progs[i + 1].s)))  \(progs[i + 1].t)" }
            DispatchQueue.main.async { if let self = self, self.cur.id == want { self.epgLabel.text = line } }
        }.resume()
    }

    // MARK: - controls

    @objc private func tapped() {
        if presentedViewController != nil { return }
        overlay.alpha > 0.5 ? hideOverlay() : showOverlay(autoHide: true)
    }

    private func showOverlay(autoHide: Bool) {
        UIView.animate(withDuration: 0.15) { self.overlay.alpha = 1 }
        hideTimer?.invalidate()
        if autoHide && !failed {
            hideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in self?.hideOverlay() }
        }
    }

    private func hideOverlay() {
        guard !failed, !dragging else { return }
        UIView.animate(withDuration: 0.25) { self.overlay.alpha = 0 }
    }

    @objc private func playPause() {
        if failed { retries = 0; usingAlt = false; return start() }
        if player.isPlaying { player.pause(); userPaused = true; saveResume() } else { player.play(); userPaused = false; lastProgress = Date() }
        showOverlay(autoHide: true)
    }

    @objc private func nextItem() { switchTo(index + 1) }
    @objc private func prevItem() { switchTo(index - 1) }
    @objc private func closeTapped() { close() }

    @objc private func openInVlc() {
        saveResume()
        let it = cur
        let u = (usingAlt && Self.isHttp(it.alt)) ? it.alt : it.url
        let parent = presentingViewController as? WebViewController
        close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { parent?.openExternal(u) }
    }

    @objc private func swiped(_ g: UISwipeGestureRecognizer) {
        guard isLive, items.count > 1 else { return }
        g.direction == .up ? switchTo(index + 1) : switchTo(index - 1)
    }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        guard g.state == .ended else { return }
        let old = cropPtr
        if g.scale > 1.1 {            // fill the screen (crops the edges)
            let b = view.bounds
            cropPtr = strdup("\(Int(b.width * 100)):\(Int(b.height * 100))")
        } else if g.scale < 0.9 {     // whole picture
            cropPtr = nil
        } else { return }
        player.videoCropGeometry = cropPtr
        if let o = old { free(o) }
    }

    @objc private func sliderBegan() { dragging = true; hideTimer?.invalidate() }
    @objc private func sliderMoved() { let d = duration(); if d > 0 { timeLabel.text = Self.fmt(Int64(Double(slider.value) * Double(d))) } }
    @objc private func sliderEnded() {
        dragging = false
        let d = duration()
        if d > 0 { player.time = VLCTime(int: Int32(Double(slider.value) * Double(d))); lastProgress = Date() }
        showOverlay(autoHide: true)
    }

    private static func fmt(_ ms: Int64) -> String {
        let s = max(0, ms / 1000), h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    // Taps on buttons and the slider aren't "show/hide the controls" taps.
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !(touch.view is UIControl)
    }

    // MARK: - layout

    private func iconButton(_ b: UIButton, _ name: String, _ size: CGFloat, _ action: Selector) {
        b.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .semibold)), for: .normal)
        b.tintColor = .white
        b.addTarget(self, action: action, for: .touchUpInside)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: max(44, size * 2)).isActive = true
        b.heightAnchor.constraint(equalToConstant: max(44, size * 2)).isActive = true
    }

    private func buildUi() {
        for v in [video, overlay] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        video.isUserInteractionEnabled = false
        NSLayoutConstraint.activate([
            video.leadingAnchor.constraint(equalTo: view.leadingAnchor), video.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            video.topAnchor.constraint(equalTo: view.topAnchor), video.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor), overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: view.topAnchor), overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        overlay.backgroundColor = UIColor(white: 0, alpha: 0.45)

        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(spinner)

        titleLabel.font = .systemFont(ofSize: 20, weight: .bold)
        subLabel.font = .systemFont(ofSize: 14, weight: .regular)
        epgLabel.font = .systemFont(ofSize: 14, weight: .medium)
        epgLabel.numberOfLines = 2
        msgLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        msgLabel.numberOfLines = 0; msgLabel.textAlignment = .center; msgLabel.isHidden = true
        for l in [titleLabel, subLabel, epgLabel, msgLabel, timeLabel, durLabel] {
            l.textColor = .white
            l.translatesAutoresizingMaskIntoConstraints = false
            overlay.addSubview(l)
        }
        subLabel.textColor = UIColor(white: 1, alpha: 0.75)
        epgLabel.textColor = Theme.accent
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        durLabel.font = timeLabel.font

        iconButton(closeBtn, "xmark", 18, #selector(closeTapped))
        iconButton(playBtn, "pause.fill", 30, #selector(playPause))
        iconButton(prevBtn, "backward.end.fill", 22, #selector(prevItem))
        iconButton(nextBtn, "forward.end.fill", 22, #selector(nextItem))
        iconButton(ccBtn, "captions.bubble", 18, #selector(pickSubs))
        iconButton(audioBtn, "speaker.wave.2", 18, #selector(pickAudio))
        iconButton(vlcBtn, "arrow.up.forward.app", 18, #selector(openInVlc))
        for b in [closeBtn, playBtn, prevBtn, nextBtn, ccBtn, audioBtn, vlcBtn] { overlay.addSubview(b) }

        slider.minimumTrackTintColor = Theme.accent
        slider.translatesAutoresizingMaskIntoConstraints = false
        slider.addTarget(self, action: #selector(sliderBegan), for: .touchDown)
        slider.addTarget(self, action: #selector(sliderMoved), for: .valueChanged)
        slider.addTarget(self, action: #selector(sliderEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        overlay.addSubview(slider)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            closeBtn.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 4), closeBtn.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
            titleLabel.leadingAnchor.constraint(equalTo: closeBtn.trailingAnchor, constant: 8), titleLabel.centerYAnchor.constraint(equalTo: closeBtn.centerYAnchor, constant: -8),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -16),
            subLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor), subLabel.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 2),
            subLabel.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -16),
            epgLabel.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor), epgLabel.topAnchor.constraint(equalTo: subLabel.bottomAnchor, constant: 8),
            epgLabel.trailingAnchor.constraint(lessThanOrEqualTo: g.trailingAnchor, constant: -16),
            playBtn.centerXAnchor.constraint(equalTo: view.centerXAnchor), playBtn.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            prevBtn.trailingAnchor.constraint(equalTo: playBtn.leadingAnchor, constant: -48), prevBtn.centerYAnchor.constraint(equalTo: playBtn.centerYAnchor),
            nextBtn.leadingAnchor.constraint(equalTo: playBtn.trailingAnchor, constant: 48), nextBtn.centerYAnchor.constraint(equalTo: playBtn.centerYAnchor),
            msgLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor), msgLabel.topAnchor.constraint(equalTo: playBtn.bottomAnchor, constant: 16),
            msgLabel.widthAnchor.constraint(lessThanOrEqualTo: g.widthAnchor, multiplier: 0.8),
            vlcBtn.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -4), vlcBtn.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -6),
            audioBtn.trailingAnchor.constraint(equalTo: vlcBtn.leadingAnchor), audioBtn.centerYAnchor.constraint(equalTo: vlcBtn.centerYAnchor),
            ccBtn.trailingAnchor.constraint(equalTo: audioBtn.leadingAnchor), ccBtn.centerYAnchor.constraint(equalTo: vlcBtn.centerYAnchor),
            timeLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16), timeLabel.centerYAnchor.constraint(equalTo: vlcBtn.centerYAnchor),
            slider.leadingAnchor.constraint(equalTo: timeLabel.trailingAnchor, constant: 10), slider.centerYAnchor.constraint(equalTo: vlcBtn.centerYAnchor),
            durLabel.leadingAnchor.constraint(equalTo: slider.trailingAnchor, constant: 10), durLabel.centerYAnchor.constraint(equalTo: vlcBtn.centerYAnchor),
            durLabel.trailingAnchor.constraint(equalTo: ccBtn.leadingAnchor, constant: -10),
        ])
        timeLabel.setContentHuggingPriority(.required, for: .horizontal)
        durLabel.setContentHuggingPriority(.required, for: .horizontal)

        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        view.addGestureRecognizer(tap)
        for dir in [UISwipeGestureRecognizer.Direction.up, .down] {
            let s = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
            s.direction = dir
            view.addGestureRecognizer(s)
        }
        view.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))
    }
}
