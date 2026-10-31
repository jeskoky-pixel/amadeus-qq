# Amadeus Qq

[简体中文](README.zh-CN.md) · [Detailed configuration](REFERENCE.md) · [Issues](https://github.com/jeskoky-pixel/amadeus-qq/issues)

QQ conversations with persistent DSH Sessions and explicit Scene permissions.

Target package: **`@fg-lab/amadeus-qq@1.2.1`**. Tested runtime baseline: official DSH Desktop **0.2.1-rc.3**. MIT licensed.

## Release status

Productization candidate. Public npm and GitHub Release publication are pending release gates and npm account authorization. A version in this README is not evidence of publication. See [publishing policy](docs/PUBLISHING.md).

## Install and configure

Install the prebuilt `.tgz` with the official DSH plugin manager into your selected Profile. No local source build is required. Follow [installation instructions](docs/INSTALL_V1_2.md); do not copy configuration into a running Profile by hand.

Connect NapCat, choose a Workspace, set the Owner QQ number and authorize individual Scenes. Start with Observe.

The other Amadeus plugins are optional. Install only the integrations you need.

## Interface

![Amadeus Qq interface](docs/screenshots/product-release-20261031.png)

This is a recorded interface screenshot, not evidence that every real platform capability passed the current release gate. See the detailed reference and verification reports for limitations.

## Upgrade and recovery

Back up user data before upgrading. Code, persistent user data and recovery backups are separate. Disable stops functionality; uninstall is intended to retain external data. Restoring old code alone does not reverse a database migration.

- [Upgrade policy](docs/UPGRADE_POLICY.md)
- [Data migration and recovery](docs/DATA_MIGRATION.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)
- [Full configuration and limitations](REFERENCE.md)

## Ecosystem and license

[Amadeus project](https://github.com/jeskoky-pixel/Amadeus-dsh) · [MIT license](LICENSE)
