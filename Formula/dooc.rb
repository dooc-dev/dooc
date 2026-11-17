class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.16"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.16/dooc-darwin-arm64.tar.gz"
      sha256 "7052aba15ad41be173d6577f719210a9bee4656cfc902ca6d29874ff27e074b1"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.16/dooc-darwin-x64.tar.gz"
      sha256 "818f2ec6963420ac02de69b26f635d43906387c28ef2f425914b8d4e8ba2a700"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.16/dooc-linux-arm64.tar.gz"
      sha256 "8009ccc1fbd5c35e588f2b475020cda8cc1728b1c9a3d0c7ad7b755a6c9e5334"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.16/dooc-linux-x64.tar.gz"
      sha256 "e6ac4e3a0ea930aeb572018a5e3b9a99780fd36c485fa118eef258cb84204498"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
