class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.23"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.23/dooc-darwin-arm64.tar.gz"
      sha256 "b74b68cc0316ac5f900372b95782ce8822c1fdcb7e2226e925dfa8cd106366b6"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.23/dooc-darwin-x64.tar.gz"
      sha256 "5278e7bac4531cdc64668a8186850e13ff2fcf78364249ae65328e7a945c045c"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.23/dooc-linux-arm64.tar.gz"
      sha256 "05236d4e1c0554a6646945d6b32cf067bf0451bf04afb4ccf4ba87d04b32bb5a"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.23/dooc-linux-x64.tar.gz"
      sha256 "a20f2800b217e64dc304ef2a9cd87d67a90dc82e5baee6f03c43d43b3a9d62d7"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
