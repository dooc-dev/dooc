#!/bin/sh
set -eu

install_dooc() {
    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *) echo "dooc supports Linux and macOS." >&2; exit 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) arch=x64 ;;
        arm64|aarch64) arch=arm64 ;;
        *) echo "dooc supports x64 and arm64 CPUs." >&2; exit 1 ;;
    esac
    version=${DOOC_VERSION:-latest}
    base=https://github.com/dooc-dev/dooc/releases
    if [ "$version" = latest ]; then
        url=$base/latest/download
    else
        version=${version#v}
        case "$version" in
            ''|*[!0-9.]*) echo "DOOC_VERSION must be a release version, e.g. 0.0.2." >&2; exit 1 ;;
        esac
        url=$base/download/dooc-v$version
    fi
    asset=dooc-$os-$arch.tar.gz
    temp=$(mktemp -d)
    staged=
    trap 'rm -rf "$temp"; if [ -n "$staged" ]; then rm -f "$staged"; fi' EXIT
    trap 'exit 1' HUP INT TERM
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url/SHA256SUMS" -o "$temp/SHA256SUMS"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$url/$asset" -o "$temp/$asset"
    expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temp/SHA256SUMS")
    if [ "${#expected}" -ne 64 ]; then
        echo "Missing or invalid checksum for $asset." >&2
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$temp/$asset")
    else
        actual=$(shasum -a 256 "$temp/$asset")
    fi
    if [ "${actual%% *}" != "$expected" ]; then
        echo "Checksum mismatch; the existing dooc installation was kept." >&2
        exit 1
    fi
    tar -xzf "$temp/$asset" -C "$temp" dooc
    [ -f "$temp/dooc" ] && [ ! -L "$temp/dooc" ]
    install_dir=${DOOC_INSTALL_DIR:-"$HOME/.local/bin"}
    if [ -d "$install_dir/dooc" ]; then
        echo "$install_dir/dooc is a directory." >&2
        exit 1
    fi
    mkdir -p "$install_dir"
    staged=$(mktemp "$install_dir/.dooc.XXXXXX")
    cp "$temp/dooc" "$staged"
    chmod 755 "$staged"
    mv -f "$staged" "$install_dir/dooc"
    staged=
    echo "Installed dooc to $install_dir/dooc"
    case ":$PATH:" in
        *":$install_dir:"*) ;;
        *) echo "Add $install_dir to PATH to run dooc." ;;
    esac
}

install_dooc
