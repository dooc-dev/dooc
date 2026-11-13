class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.10"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.10/dooc-darwin-arm64.tar.gz"
      sha256 "1f7f773cbe8ed8d9b01bfb843a4d8cbbaaaf0257dcae019239abb3a3ebb47ae0"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.10/dooc-darwin-x64.tar.gz"
      sha256 "36b7c4e90f488fba6f520c8ef0e959a880d534192552e6b2ec20e7c283cd5cb6"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.10/dooc-linux-arm64.tar.gz"
      sha256 "65387c8f362b1cd57437a22f61091eb73ffc4244f06d58814fe27e7a12284857"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.10/dooc-linux-x64.tar.gz"
      sha256 "b32bfe1efb9d6dda8e7e92e58c52178c3d8811505ade77f00c75c72adb7a3bf6"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
