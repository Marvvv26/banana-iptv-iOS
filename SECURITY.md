# Banana IPTV for iPhone: security notes (v0.1.0, 17 Nov 2026)

- **Passwords** go in the iOS Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`): encrypted by the iPhone, never synced to iCloud and never written anywhere else. The interface only gets them in memory while the app runs.
- **No servers of ours.** The app talks only to your IPTV provider and the artwork links it supplies. Nothing is collected or sent anywhere else. Diagnostics stay on the phone.
- **Interface isolation:**
  - The interface is loaded from the app bundle via a private `banana://app/` scheme, and the web view can't navigate anywhere else.
  - Its provider requests go through the app (`/net`): GET only, http/https only, no cookies, nothing cached.
  - Bundled files are served only from inside the app's `web` folder; path traversal is refused.
- **Player:** MobileVLCKit (VideoLAN), given only http/https stream links. "Open in VLC" hands the link to VLC for iOS through its official `vlc-x-callback` URL.
- **Plain http** is allowed (`NSAllowsArbitraryLoads`) because most IPTV providers only offer http. As with any IPTV app, your login travels unencrypted to such providers.
- **Remembered data** is resume points and recently watched channel numbers only. Stream links are never stored, because they contain the password.
- **Builds** run on GitHub Actions, with every action pinned to a commit and kept up to date by Dependabot. Semgrep scans the code on every push. The `.ipa` is unsigned, so no signing keys exist in this repository.
- **Public repository:** this repo is public (which also makes GitHub's Mac build machines free). It contains no passwords, server addresses or keys. Never commit any.
