class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.25"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.25/dooc-darwin-arm64.tar.gz"
      sha256 "39c009b01b51520a4ad4091d884b8977e6503ff690e165f22a192e173d77d060"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.25/dooc-darwin-x64.tar.gz"
      sha256 "f9e02c19bc0dbfe1ac5d9d619975aa8a12b54329c1534b2b3e2aecb72e985740"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.25/dooc-linux-arm64.tar.gz"
      sha256 "3f142b54028c64e228df80b628fbe43118724dbc9440910e1b42ed37eb7ac8b9"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.25/dooc-linux-x64.tar.gz"
      sha256 "de300aa5615e62a6018b49e1ebc4b8adf347a0842e771453bafccab2227f08c5"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
