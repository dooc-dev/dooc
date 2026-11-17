class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.15"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.15/dooc-darwin-arm64.tar.gz"
      sha256 "9be6cf6c167ce502eadfdd8f67d6a7a59f01fa568468065ef9558e7425f2fcaf"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.15/dooc-darwin-x64.tar.gz"
      sha256 "39388f5a8d99f83c83755bd68e4ccb6a721d2ea488eca286945d7486261cc97d"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.15/dooc-linux-arm64.tar.gz"
      sha256 "4a1bb19be9043683f4e907d119387550d995933fd61f974cde497ed3caa27a0c"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.15/dooc-linux-x64.tar.gz"
      sha256 "9b777f866c645e3cb6ee51c93380df966f874ae49034a05f4b5ff6970deef147"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
