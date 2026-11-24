class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.22"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.22/dooc-darwin-arm64.tar.gz"
      sha256 "d92729da006a464de92fa57927d9ce2c9fd73ec2c15a93ff3221164edfee7683"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.22/dooc-darwin-x64.tar.gz"
      sha256 "cf5bc30f89ea5eace6e38abcfda6ab61d7ecffd824b6ff3119a400127da0bb59"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.22/dooc-linux-arm64.tar.gz"
      sha256 "963ed4d3df933b85ff5ecc71b8a4f96a091aca8866abf9e917b14706aeb42a49"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.22/dooc-linux-x64.tar.gz"
      sha256 "9d97cecdd5fbe7914849334b1d57174005468354ceb4c45eeb3ffc2766ed7bcd"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
