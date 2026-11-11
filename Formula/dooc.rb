class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.4"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.4/dooc-darwin-arm64.tar.gz"
      sha256 "10a6204a32c43f2bdd99ce0eff5570bc1bc827caf91112da5b826d55a1c18df4"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.4/dooc-darwin-x64.tar.gz"
      sha256 "c6fbab4eabcfe20d7eccea7e15c9882892fd35ebcd2646571eca1d4d3cd9bd22"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.4/dooc-linux-arm64.tar.gz"
      sha256 "4a0ac7acf45e4cd958a471481f6d4b8ff01e6fc83577d6ce521469e457c819f8"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.4/dooc-linux-x64.tar.gz"
      sha256 "f11044be9cb036d8fc8f19bc0f0293f2209107fe44ee47de4983bfe6aecd2990"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
