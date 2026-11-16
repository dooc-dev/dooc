class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.13"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.13/dooc-darwin-arm64.tar.gz"
      sha256 "b937e3a229d5e94465288b99fd02b7da541b77638c4e070e4041dda7bcd52820"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.13/dooc-darwin-x64.tar.gz"
      sha256 "5f98c2c3a7c4245242e911328dd7c29b4eb71f68d36a92d730f93e647482f6bf"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.13/dooc-linux-arm64.tar.gz"
      sha256 "51609c336b3732ef7325dcd52f78e533b25707d3551b981ec583a7ab3eb3d2e7"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.13/dooc-linux-x64.tar.gz"
      sha256 "c9c0ad1d43f9b4232e475f20363aaa407bd055b3e543f549a5130ccbb0c72e18"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
