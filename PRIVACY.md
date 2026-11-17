# Privacy

Last reviewed: 2026-11-06.

TABLA runs locally in your Chrome profile. It reads tab URLs, titles, opener relationships, and tab/group layout to organize tabs and repair groups after restart. These snapshots and your settings are stored using Chrome’s local extension storage. Temporary coordination and undo state use session storage. Theme preference uses localStorage shared by the extension’s menu and settings page.

Sessions you explicitly save are stored locally until you delete them or uninstall TABLA. They contain tab URLs/titles, including supported Chrome and extension pages, order, pinned state, and group names/colors. Save & close writes the session before closing captured tabs. Restoring opens saved pages; page contents, forms, and navigation history are not saved. Saved sessions are separate from automatic recovery and settings exports.

Auto group colors read small website icons through Chrome’s internal favicon service. A bounded local cache stores site origins, derived color names, icon-URL hashes, and timestamps for up to 256 sites. It does not store image pixels or fetch icons directly from website servers. Missing/unreadable icons use a fallback. Temporary Auto-color ownership records use session storage so manual color/name choices are preserved.

No telemetry, analytics, accounts, cloud synchronization, remote scripts, page-content access, or third-party image services are used. Incognito windows are excluded. The GitHub footer opens an external page only when clicked. Settings exports contain settings/rules/exclusions, not browsing snapshots or the favicon-color cache.

Uninstalling the extension removes its Chrome-managed storage. Exported strings or files you save separately remain wherever you saved them.

Use of browsing information is limited to the tab-management features described above and follows the Chrome Web Store User Data Policy, including its Limited Use requirements. This policy will be updated if those practices change.

For privacy questions, use the contact information on the extension's store listing when available. Developer profile: [hgurb](https://github.com/hgurb).
