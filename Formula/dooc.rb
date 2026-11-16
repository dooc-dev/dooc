class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.14"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.14/dooc-darwin-arm64.tar.gz"
      sha256 "3275be72cca40a736e06f2a810803713b7dbbf47a6375cd0a7267a90e74e1971"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.14/dooc-darwin-x64.tar.gz"
      sha256 "a9a67635243e3d5d9c3b4439c4be669758d163eace4ec9b119cb9e9603155b83"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.14/dooc-linux-arm64.tar.gz"
      sha256 "7ae4f0c05b564e01711ddadfe7430e6726282012f5117cfb085761f8c3e8d283"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.14/dooc-linux-x64.tar.gz"
      sha256 "8d8d44de74a73aaac75f2c6ed044fda58499602f228ba936305ef2f551d0cf76"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
