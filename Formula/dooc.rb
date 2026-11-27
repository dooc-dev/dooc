class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.24"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.24/dooc-darwin-arm64.tar.gz"
      sha256 "57b09052f01f160e37de5c72806a0e8d7ff265543df3b0d38beedc31f1ea9009"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.24/dooc-darwin-x64.tar.gz"
      sha256 "5261dd93eae852764382fe1081e1cfa1a219da9b0d49fa0e0900ca933a9b0efa"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.24/dooc-linux-arm64.tar.gz"
      sha256 "ace9cb40a1443f57b7510d70b13a54defdd52f188aac42ee2c7e04794a31b40b"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.24/dooc-linux-x64.tar.gz"
      sha256 "0c39219b9269bdcfc47b6bc87840bf54b2f02b8a1115a98f87daa24a9ddc1139"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
