# Banana IPTV for iPhone (v0.1.0)

The Banana IPTV app for iPhone: your Xtream IPTV login with Live TV, Movies, Series, Football, Search, profiles, favourites and Continue watching. Same interface as the Fire TV app, adapted for touch, with VLC's player engine built in.

## Using it
- The app runs in landscape.
- **Tap** to open things. **Swipe** up and down the channel list and poster grids. **Touch and hold** a channel, film or series for its options (favourite, Add to Football, Open in VLC).
- **Back:** the ‹ button at the top left, or swipe in from the left edge.
- **Player:**
  - Tap the screen to show the controls: subtitles, audio track, Open in VLC, and next/previous channel or episode.
  - On live TV, swipe up or down to change channel.
  - Pinch out to fill the screen, pinch in to show the whole picture.

## Installing (no App Store)
GitHub builds an **unsigned** `.ipa` on every change: open **Actions › Build iPhone app** and download **BananaIPTV-iOS**. An iPhone only runs apps signed for it, so the `.ipa` has to be signed as it goes on. Two ways:
- **Free Apple ID with Sideloadly or AltStore:** signs and installs it from a PC. With a free account the app must be refreshed every 7 days.
- **Apple Developer account (£79/year):** apps last a year and can be installed through TestFlight.

## How it's built
- `web/`: the shared interface, the same code as the Fire TV app plus a touch layer at the end of `src/main.js`. It's bundled with esbuild at build time.
- `BananaIPTV/`: the native app (Swift).
  - `WebViewController` hosts the interface.
  - `AppSchemeHandler` serves it from the app and fetches provider data for it.
  - `PlayerViewController` plays streams with MobileVLCKit.
  - `Keychain` stores passwords. `PlayerStore` stores resume points and recent channels.
- `project.yml` (XcodeGen) and `Podfile` (CocoaPods) describe the Xcode project. The build machine generates it, so no Mac is needed to change the app.
