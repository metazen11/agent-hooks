# Scheduled auto-updates for the contracts hook

The SessionStart hook (`update-check.js`) surfaces update banners
opportunistically. If you'd rather pull updates on a schedule — before you
even start a Claude session — wire `pull-and-update.sh` into launchd (macOS)
or anacron (Linux).

Both examples mirror the pattern used by
`~/_CODING/autonomous_agents_mds/scripts/sync_prompt_pack.py` (see its
`print-launchd` and `print-anacron` actions). You can copy the shape from
there and adapt paths.

## macOS — launchd (daily at 09:15)

Save as `~/Library/LaunchAgents/com.metazen.contracts-hook-update.plist`,
then `launchctl load` it.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>              <string>com.metazen.contracts-hook-update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>$HOME/_CODING/hooks/contracts/pull-and-update.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key>    <string>/tmp/contracts-hook-update.log</string>
  <key>StandardErrorPath</key>  <string>/tmp/contracts-hook-update.err</string>
  <key>RunAtLoad</key>          <false/>
</dict>
</plist>
```

Load: `launchctl load ~/Library/LaunchAgents/com.metazen.contracts-hook-update.plist`

## Linux — anacron (daily)

Root install: add to `/etc/anacrontab`. User install: use `~/.anacron/etc/anacrontab` with a per-user anacron runner.

```
# period  delay  job-identifier    command
1         5      contracts-hook    /bin/bash -lc "$HOME/_CODING/hooks/contracts/pull-and-update.sh"
```

## Notes

- `pull-and-update.sh` is fast-forward-only. If your local hooks repo has
  drifted (uncommitted changes or a divergent branch), the scheduled run
  exits non-zero and does nothing — resolve manually per CONTRACT §7.
- The SessionStart banner remains useful even with scheduled updates: it
  covers the window between one scheduled run and the next.
- Redirect stdout/stderr to a log path you'll actually check — silent
  failures are worse than none.
