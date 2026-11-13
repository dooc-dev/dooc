class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.8"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.8/dooc-darwin-arm64.tar.gz"
      sha256 "60a8509e28e4de0e16bef14e563a2429820f59c7aee0db6876427f33bb827f7f"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.8/dooc-darwin-x64.tar.gz"
      sha256 "5d3a5066bc36819788b42a908b22ec27b4278f60ac6252d63875c42bdc4c4ab9"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.8/dooc-linux-arm64.tar.gz"
      sha256 "3ebc11082f3300890c2f108584a994373c58fa23853abeff840c6564f6e7bffa"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.8/dooc-linux-x64.tar.gz"
      sha256 "5e3ed1925e3963093d682151c786df3cad5abfbfdfba90f1696ec5701076bf05"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
