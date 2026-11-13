class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.11"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.11/dooc-darwin-arm64.tar.gz"
      sha256 "3c2d3f7cccd8717daefae999bb56f8924736f293e6439071de5116e227374f65"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.11/dooc-darwin-x64.tar.gz"
      sha256 "b880dcde75b43da80843ce2dff8d2f8ba0e116117bbb2117bdebec1e98438373"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.11/dooc-linux-arm64.tar.gz"
      sha256 "2b6a97f14cf15f03870b4a74cde951f6cb810d00c972c73ad5650f6a3776376a"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.11/dooc-linux-x64.tar.gz"
      sha256 "3eb8ff31eeec776466892650e23c454eff8e93993cc89fc1fb937eeb4173f086"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
