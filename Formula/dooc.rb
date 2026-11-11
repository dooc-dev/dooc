class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.7"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.7/dooc-darwin-arm64.tar.gz"
      sha256 "7963b3cb3768e0a084aac65585118d1770317137a1b9de3e1c42517be4c159d8"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.7/dooc-darwin-x64.tar.gz"
      sha256 "70ca2917dbbab9939a4f23a0e7d512f7dd7fa9f50d8ab229df6e33345734908b"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.7/dooc-linux-arm64.tar.gz"
      sha256 "eeaa4edfd343d4ffa8818f8b66d9462d796464b2497a77043e3b1ec32ca28b29"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.7/dooc-linux-x64.tar.gz"
      sha256 "42ccce629a717931a36b74ce099aa073ce9e2cc875393824fc52f8a32cb75051"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
