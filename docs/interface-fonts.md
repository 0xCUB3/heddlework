# Desktop interface fonts

Settings → Interface has separate **Interface font** and **Code font** fields. Enter an installed family name and click Apply or press Enter. Interface font controls menus and chat text. Code font controls code and diffs. Changes apply immediately and survive restarts. Reset interface fonts restores the shipped families without changing the color theme or terminal settings.

For Comic Shanns on macOS, install its OTF files in `~/Library/Fonts/` and use the exact family name, for example `ComicShannsMono Nerd Font Mono`. Heddlework resolves installed fonts through the native text system. It does not install fonts or validate that a typed family exists. Missing families fall back through the platform text system.

Desktop preferences are saved under `interfaceFonts` in `preferences.json`:

```json
{
  "interfaceFonts": {
    "fontSans": "ComicShannsMono Nerd Font Mono",
    "fontMono": "ComicShannsMono Nerd Font Mono"
  }
}
```

The preference file lives at `~/Library/Application Support/Heddlework/preferences.json` on macOS, `%APPDATA%/Heddlework/preferences.json` on Windows, or `${XDG_CONFIG_HOME:-~/.config}/heddlework/preferences.json` on Linux. Preserve other keys when editing it manually and restart the app afterward.

[Terminal fonts](terminal.md#fonts-and-live-settings) remain separate. Desktop font choices do not configure the browser or iOS clients, or change the fonts inside embedded websites.
