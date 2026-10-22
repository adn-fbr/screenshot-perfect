<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Camera capture and recording run in the browser (getUserMedia + one MediaRecorder per camera); a separate local capture service is only added if browser capture proves insufficient on target hardware.
- Footage is written to an operator-chosen local folder (File System Access API) as per-camera segment files plus a session manifest JSON; never store video in a database.
- Pure camera rules live in src/lib/vsr/ with vitest tests; UI never fakes connection state — status comes from real track/frame events.
