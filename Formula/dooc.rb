class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.18"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.18/dooc-darwin-arm64.tar.gz"
      sha256 "f23957c9a755d602c3a9f27b89f35f7f612eff85c66f7cc0322e9606fd72311f"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.18/dooc-darwin-x64.tar.gz"
      sha256 "5178aee52cb58aaf3809a03fb3cb9ca45c1a29c3f65fa90ecba589f066ab4a15"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.18/dooc-linux-arm64.tar.gz"
      sha256 "d982a625385ff027278425cb81e313b99d804e8ec108a191e62309d711aa2f13"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.18/dooc-linux-x64.tar.gz"
      sha256 "3aefa223cdd9a26f403cdfc63ad0e20c455890b20d27e81c13a87ef1db7f5660"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
