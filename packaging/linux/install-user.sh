#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
source_binary=${HEDDLEWORK_BUILD:-"$repo_root/dist/heddlework"}
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
bin_dir=${HEDDLEWORK_BIN_DIR:-"$HOME/.local/bin"}
app_dir=${HEDDLEWORK_APP_DIR:-"$data_home/heddlework"}
applications_dir="$data_home/applications"
icons_root="$data_home/icons/hicolor"
icons_dir="$icons_root/scalable/apps"
desktop_id=io.github.monotykamary.heddlework
launcher="$bin_dir/heddlework"
installed_binary="$app_dir/heddlework"
icon="$icons_dir/$desktop_id.svg"
desktop_file="$applications_dir/$desktop_id.desktop"
template="$repo_root/packaging/linux/$desktop_id.desktop"
# In the source tree the SVG lives in media/; the release tarball keeps a copy beside the PNG set under packaging/linux/icons.
icon_source="$repo_root/media/heddlework-icon.svg"
[ -f "$icon_source" ] || icon_source="$repo_root/packaging/linux/icons/heddlework-icon.svg"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_absolute() {
  case "$2" in
    /*) ;;
    *) fail "$1 must be an absolute path: $2" ;;
  esac
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

absolute_path_only() {
  input=$1
  output=
  old_ifs=$IFS
  IFS=:
  for entry in $input; do
    case "$entry" in
      /*)
        if [ -z "$output" ]; then
          output=$entry
        else
          output="$output:$entry"
        fi
        ;;
    esac
  done
  IFS=$old_ifs
  printf '%s' "$output"
}

require_absolute XDG_DATA_HOME "$data_home"
require_absolute HEDDLEWORK_BIN_DIR "$bin_dir"
require_absolute HEDDLEWORK_APP_DIR "$app_dir"
[ -x "$source_binary" ] || fail "build the executable first with 'bun run build' (missing $source_binary)"
[ -f "$template" ] || fail "desktop template is missing: $template"

pi_executable=${HEDDLEWORK_PI:-}
if [ -z "$pi_executable" ]; then
  pi_executable=$(command -v pi || true)
fi
[ -n "$pi_executable" ] || fail "Pi was not found; set HEDDLEWORK_PI to its absolute executable path"
require_absolute HEDDLEWORK_PI "$pi_executable"
[ -x "$pi_executable" ] || fail "Pi is not executable: $pi_executable"
pi_directory=$(CDPATH='' cd -- "$(dirname -- "$pi_executable")" && pwd)
pi_executable="$pi_directory/$(basename -- "$pi_executable")"

launch_path=$(absolute_path_only "${HEDDLEWORK_LAUNCH_PATH:-$PATH}")
[ -n "$launch_path" ] || launch_path=/usr/local/bin:/usr/bin:/bin
case ":$launch_path:" in
  *":$pi_directory:"*) ;;
  *) launch_path="$pi_directory:$launch_path" ;;
esac

install -d "$app_dir" "$bin_dir" "$applications_dir" "$icons_dir"
install -m 755 "$source_binary" "$installed_binary"
install -m 644 "$icon_source" "$icon"
for size in 16 32 48 64 128 256 512; do
  raster="$repo_root/packaging/linux/icons/$size.png"
  [ -f "$raster" ] || continue
  install -d "$icons_root/${size}x${size}/apps"
  install -m 644 "$raster" "$icons_root/${size}x${size}/apps/$desktop_id.png"
done

umask 077
{
  printf '#!/bin/sh\n'
  printf 'set -eu\n'
  printf 'export PATH='
  shell_quote "$launch_path"
  printf '\nexport HEDDLEWORK_PI='
  shell_quote "$pi_executable"
  printf "\ncd \"\${HEDDLEWORK_WORKSPACE:-\$HOME}\"\nexec "
  shell_quote "$installed_binary"
  printf ' "$@"\n'
} > "$launcher"
chmod 700 "$launcher"

# The sed expression treats desktop-entry metacharacters as data.
# shellcheck disable=SC2016
desktop_exec=$(printf '%s' "$launcher" | sed 's/\\/\\\\/g; s/"/\\"/g; s/`/\\`/g; s/\$/\\$/g')
{
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      'Exec=@HEDDLEWORK_EXEC@') printf 'Exec="%s"\n' "$desktop_exec" ;;
      'TryExec=@HEDDLEWORK_EXEC@') printf 'TryExec=%s\n' "$launcher" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < "$template"
} > "$desktop_file"
chmod 600 "$desktop_file"

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t "$icons_root" >/dev/null 2>&1 || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_dir" >/dev/null 2>&1 || true
fi

printf 'Installed Heddlework desktop preview:\n'
printf '  executable: %s\n' "$installed_binary"
printf '  launcher:   %s\n' "$launcher"
printf '  desktop:    %s\n' "$desktop_file"
printf '  icon:       %s\n' "$icon"
printf 'GNOME/Wayland may require a logout and login before replacing a cached launcher entry.\n'
