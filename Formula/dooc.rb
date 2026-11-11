class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.5"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.5/dooc-darwin-arm64.tar.gz"
      sha256 "1506a63145f18704aaab2c1b1853125cbbc3efb7db7992de37e455966defa71c"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.5/dooc-darwin-x64.tar.gz"
      sha256 "c1f5daa2f458ed8bfbcd22a6f47e9491a52ac6f7864db9255ab6fa2388110e4a"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.5/dooc-linux-arm64.tar.gz"
      sha256 "493061f5ade226b29055f8a8581d9e3eec2d3bd01f795f885b9425f9758aceab"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.5/dooc-linux-x64.tar.gz"
      sha256 "e0285c843a17f80a698d8cd0463b0006278ca7f55499d71b0499b07219d5b8ea"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
