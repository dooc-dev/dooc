class Dooc < Formula
  desc "Compile, preview, and edit documentation"
  homepage "https://github.com/dooc-dev/dooc"
  version "0.0.12"
  version_scheme 1

  on_macos do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.12/dooc-darwin-arm64.tar.gz"
      sha256 "5ea8d2dc00bddae6effcf68a985a8a17e6b279eff2298b2cceb173dcd7090dd3"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.12/dooc-darwin-x64.tar.gz"
      sha256 "6c61ccb994de397e8465878e89db50d7a0b937e7ef798166dea8eedf734da898"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.12/dooc-linux-arm64.tar.gz"
      sha256 "aff0c88259e927c4f6ccad0e709ae10a6ea6ad298af380df2777b16faf5ddaae"
    end
    on_intel do
      url "https://github.com/dooc-dev/dooc/releases/download/dooc-v0.0.12/dooc-linux-x64.tar.gz"
      sha256 "751a749630782a85a6b0311e5d5c4666facf237cda7fe823b2289fe52d776562"
    end
  end

  def install
    bin.install "dooc"
  end

  test do
    assert_match "usage: dooc", shell_output("#{bin}/dooc --help")
  end
end
