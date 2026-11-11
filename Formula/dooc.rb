class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.6"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.6/dooc-darwin-arm64.tar.gz"
      sha256 "cdad0eadf8eb96cb699ba7c0b510ac100ebeeb4468c37bb2593450af519b25b8"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.6/dooc-darwin-x64.tar.gz"
      sha256 "7e8ca767ae3dd4f410c354ebe1240e46d6670af3bf5eec17fc40be126a2719bf"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.6/dooc-linux-arm64.tar.gz"
      sha256 "42987519d0882d15b79ada06b42b8384ae834ffc2d90cacc59d69ce28e8df992"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.6/dooc-linux-x64.tar.gz"
      sha256 "d92fd8725a447e22356e7cc24d24558aeb1bb63bd884be6dfe64c87d8b8005bb"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
