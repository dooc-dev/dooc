class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.9"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.9/dooc-darwin-arm64.tar.gz"
      sha256 "6f22f2ab9f1bb4c2824bfe7d23684095d04bdd82c0e8fececb0d846cf1236bb1"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.9/dooc-darwin-x64.tar.gz"
      sha256 "cb0e4ab1f4af5cc91a93d24211583464b8914ddd9b18a6fa5ca3a2fc05676247"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.9/dooc-linux-arm64.tar.gz"
      sha256 "b9f5a8092477d3d8e323559aa610854b4dfe36f35f92f08a9a51b8e440405986"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.9/dooc-linux-x64.tar.gz"
      sha256 "942c039d29058f835cce84c8c03eef2f7931ee3ef2646863afd014664655f124"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
