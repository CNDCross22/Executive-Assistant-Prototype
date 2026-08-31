# Microsoft Graph capabilities

The application uses delegated Microsoft Graph access for one signed-in Director. The OpenAI model never receives an access token and never constructs a Graph request. It can only propose registered tools with schema-validated arguments.

| Granted permission | Assistant capability |
| --- | --- |
| `User.Read` | Read the connected Director profile |
| `User.ReadBasic.All` | Search basic organisation-directory profiles |
| `offline_access` | Refresh access silently through the encrypted MSAL token cache |
| `Mail.Read` / `Mail.ReadWrite` | Read, search, draft, mark, flag, move, archive and delete messages |
| `Mail.Send` | Send new mail, replies, forwards and existing drafts |
| `Calendars.Read` / `Calendars.ReadWrite` | Read, create, update and delete events and meetings |
| `Contacts.Read` / `Contacts.ReadWrite` | Search, create, update and delete Outlook contacts |
| `People.Read` | Find people relevant to the Director |
| `MailboxSettings.Read` / `MailboxSettings.ReadWrite` | Read and update timezone, working hours and automatic replies |
| `Tasks.Read` / `Tasks.ReadWrite` | Read, create, update, complete and delete Microsoft To Do tasks |
| `Team.ReadBasic.All` | List Teams the signed-in Director has joined |
| `Channel.ReadBasic.All` | List channel names and descriptions |
| `ChannelMessage.Read.All` | Read channel posts on behalf of the signed-in Director |
| `Files.Read` | List, search and read supported files in the Director's OneDrive |
| `Sites.Read.All` | Search accessible SharePoint sites and read their document libraries |

All permissions used by Hermes are **Delegated**. No Microsoft Graph Application permission is
requested or supported. New Phase 6 permissions are read-only; there is no Teams send, file upload,
sharing, rename, move or delete tool.

## Phase 6 read surfaces

Attachments use the existing delegated `Mail.ReadWrite` grant. Microsoft documents `Mail.Read` as
the least-privileged delegated permission for listing and reading message attachments, so no new mail
permission is needed. The reading pane exposes metadata only. Agent inspection is limited to
allowlisted text, Markdown, CSV, JSON, XML, YAML and HTML files up to 5 MB.

OneDrive uses delegated `Files.Read`. SharePoint search and document access use delegated
`Sites.Read.All`. Teams discovery uses delegated `Team.ReadBasic.All` and
`Channel.ReadBasic.All`; reading channel posts uses delegated `ChannelMessage.Read.All`.

Every retrieved body, channel post and document is converted to bounded plain text and labelled as
untrusted external content. Files are not executed and Hermes does not claim to malware-scan them.
PDF and Office document text extraction is deliberately deferred until a separately tested parser
and file-security design exists.

After deploying Phase 6, reconnect the Microsoft account so MSAL can request the new delegated
scopes. `ChannelMessage.Read.All` requires administrator consent according to Microsoft's current
permission reference. Tenant consent policy may require an administrator for other scopes too, so
granting tenant-wide admin consent to the exact delegated list is the predictable setup path.

Read-only calls run immediately. Every operation that changes Microsoft 365 or assistant memory first resolves the exact existing target, creates a full preview, and waits for the Director to approve or cancel. Preview cards persist through a page refresh. Pending actions are user-bound and conversation-bound, expire after 15 minutes, and are atomically claimed to prevent double execution. Only one may be pending in a conversation, and any intervening message supersedes it.

The assistant cannot substitute a prose confirmation for a real action card. If an approved Microsoft request has an ambiguous network outcome, the Director is told to check Outlook before retrying rather than risking a duplicate action.

## Executive calendar reads

`calendar_list` uses the v1.0 calendar view so recurring occurrences in the requested range are returned and deterministic overlap checks can be performed. Calendar create and time-change previews run that conflict check before an approval is created. A conflict is named in the preview; Hermes never silently changes the requested time.

`calendar_find_slots` uses the read-only `POST /me/calendar/getSchedule` operation with the Director and exact attendee addresses already resolved through the organisation directory. It intersects the returned availability views inside Outlook working hours. Missing availability is treated as busy. A returned slot is a recommendation only: it creates no event and sends no invitation. See Microsoft's [calendar view](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0) and [getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0) documentation.

Run `npm run test:graph` after changing Entra permissions. The smoke test validates token scopes and performs only read operations; it never sends, creates, edits or deletes Microsoft 365 data.
