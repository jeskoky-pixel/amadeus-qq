# Amadeus Qq

<img src="assets/market-icon.png" width="80" alt="Amadeus qq logo">

[简体中文](README.zh-CN.md) · [Detailed configuration](REFERENCE.md) · [Issues](https://github.com/jeskoky-pixel/amadeus-qq/issues)

QQ conversations with persistent DSH Sessions and explicit Scene permissions.

Target package: **`@fg-lab/amadeus-qq@1.2.1`**. Tested runtime baseline: official DSH Desktop **0.2.1-rc.3**. MIT licensed.

## Release status

Productization candidate. Public npm and GitHub Release publication are pending release gates and npm account authorization. A version in this README is not evidence of publication. See [publishing policy](docs/PUBLISHING.md).

## What you can do

- Connect an existing local NapCat instance to authorized groups and private chats, each with a persistent DSH Session in your Workspace.
- Continue a current conversation using read, wait, mark-read and guarded sends; deduplicate delivery attempts and preserve Session history across ordinary configuration edits.
- Handle supported text, mentions, replies and media through capability-specific checks. Provider-dependent features remain conditional.
- Choose Observe, Safe Chat, Enhanced or Autonomous Social presets; trusted administrator private chats may use Owner Agent. Global denials and QQ platform permissions always apply.
- Manage account/profile operations and optional QQ Space capabilities on their separate account page. Availability depends on the actual provider and configured grants.
- Pause NapCat listening for handoff to another application. QQ owns current conversations; optional Life owns long-term wake scheduling.

Example: authorize a test group in Observe, inspect inbound status, then select Safe Chat when ready to allow replies. Use the Web Console to inspect effective permissions instead of assuming that a preset grants every tool.

NapCat is not bundled: this plugin does not install, log in to or host NapCat. An unconfigured installation sends nothing. Dangerous tools are not enabled by default. Memory, Life, State and Persona are optional; QQ does not grant access to their private data merely by receiving a message.

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
