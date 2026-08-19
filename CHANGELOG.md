# Changelog

## [1.1.1](https://github.com/egemenyildiz/herdr-slack/compare/v1.1.0...v1.1.1) (2026-08-19)


### Bug Fixes

* bound the socket recycle timeout so a hang can't permanently disable recovery, and have doctor catch a daemon running outside launchd's supervision. ([6f77144](https://github.com/egemenyildiz/herdr-slack/commit/6f771440e07a0a1d7d181a26ec03080ce179ee10))
* make "synced Ns ago" track actual reconcile freshness, and make Refresh actually pull from herdr instead of just re-rendering the cache. ([49c552b](https://github.com/egemenyildiz/herdr-slack/commit/49c552bfd93d83c04861827d031d03d521b6b807))
* stop a malformed herdr event from crash-looping the daemon ([93494fe](https://github.com/egemenyildiz/herdr-slack/commit/93494feb97ecc5cffef97949ae6a73a606034b1a))
* stop launchd from throttling the daemon, catch a Slack socket the client loses track of, and drop unreliable url-buttons on Home's Open link. ([46764f8](https://github.com/egemenyildiz/herdr-slack/commit/46764f8293590eadd3d3662a1cd342534397b6df))

## [1.1.0](https://github.com/egemenyildiz/herdr-slack/compare/v1.0.0...v1.1.0) (2026-08-17)


### Features

* back one Slack app with many herdr sources ([#13](https://github.com/egemenyildiz/herdr-slack/issues/13)) ([33b62d1](https://github.com/egemenyildiz/herdr-slack/commit/33b62d1daa280f3d9f927761ba8c66417775380d))
* discover herds on the machine instead of trusting herdRegistryDir ([8ff8002](https://github.com/egemenyildiz/herdr-slack/commit/8ff80020be4ccc1d4e8c75a946739e8039afba82))
* sign the herd registry and navigate herds from Home ([#14](https://github.com/egemenyildiz/herdr-slack/issues/14)) ([220d73a](https://github.com/egemenyildiz/herdr-slack/commit/220d73a555d99c245b592f6fd14acd1e07e24f93))


### Bug Fixes

* keep the daemon alive when the shared registry vanishes ([f9b08f5](https://github.com/egemenyildiz/herdr-slack/commit/f9b08f55bee0ba4ad765c540fa393d8e4281f594))
* make the launch form follow the herd it is launching into ([c6de771](https://github.com/egemenyildiz/herdr-slack/commit/c6de771289fc5d74dbb0df3580f97cfdb8a6859f))

## 1.0.0 (2026-08-16)


### Features

* fail closed when herdr is unreachable ([#12](https://github.com/egemenyildiz/herdr-slack/issues/12)) ([074a088](https://github.com/egemenyildiz/herdr-slack/commit/074a088b0e72a102cb7d2b2bb29e816e7f0c1103))
* Slack remote-control plane with single-card turn UX ([#1](https://github.com/egemenyildiz/herdr-slack/issues/1)) ([bf295f6](https://github.com/egemenyildiz/herdr-slack/commit/bf295f6748b11aa3efca5b038fceec71cac39256))
