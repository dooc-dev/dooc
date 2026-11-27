# Site icon variants

## Adopted direction

The user selected Solid with the original colors: `#1a1e23` on light backgrounds and `#FFFFFF` on dark backgrounds. Use a 9-unit rounded stroke in the original 160 × 160 viewBox. Keep all letter geometry, canvas sizes, and theme behavior intact.

Apply this decision to the two documentation site SVGs, the Solid study assets, and the shared favicon in the adjacent `dooc-saas` repository. The favicon supplies SaaS browser tabs and the Console brand image. SaaS landing-page marks already use a 9-unit stroke with the existing theme foreground; verify all callers of the shared logo. The video outro uses non-scaling strokes on a 400 px canvas, so its stroke becomes 22.5 px (`9 × 400 / 160`); update the shipped landing video as well as its source.

Preserve the original thin icons as named study snapshots, mark Solid as selected, and refresh the comparison image. Other experimental palettes remain alternatives. General interface pictograms, third-party marks, and sample-document artwork have different geometry and are outside this brand-mark update. Do not alter README files or deploy either project.

Verify the original colors and geometry, generated documentation header/favicon assets, the SaaS favicon in both color schemes, the landing-page logo, and the video outro. Refresh locally generated favicon copies through the existing asset build steps.

## Design before implementation

The original dooc mark uses a 160 × 160 viewBox, a 5.5-unit rounded stroke, and four diagonal letterforms: d, o, o, c. The light asset is `#1a1e23`; the dark asset is white. The sidebar displays it at 24 px. Preserve the existing geometry and round caps while comparing color and stroke weight.

The initial phase was an asset study for visual review. Its presentation mode is Experience: let the marks lead and keep the comparison interface quiet. Independent SVG candidates and a local HTML comparison sheet made the alternatives reviewable before selecting the production assets.

## References

- [Apple, WWDC25: Say hello to the new look of app icons](https://developer.apple.com/videos/play/wwdc2025/220/): explore restrained translucency and directional highlights in one candidate.
- [Raycast press kit](https://www.raycast.com/press): study the relationship between a vivid warm accent and a dark surface.
- [Linear brand guidelines](https://linear.app/brand): preserve a clear geometric silhouette and generous surrounding space.

Use these as visual principles; retain dooc's original shapes.

## Candidates

| Candidate | Stroke | Color strategy | Intent |
| --- | --- | --- | --- |
| Original | 5.5 | Original graphite / white | Historical comparison baseline |
| A · Solid | 9 | Original graphite / white | Selected; stronger stroke with the original colors |
| B · Lagoon | 8 | Deep teal letters, turquoise rings | Calm two-color alternative |
| C · Signal | 8 | Blue d, orange upper o, teal lower o, violet c | Make the four letterforms distinct |
| D · Ember | 7.5 | Warm red letters, orange rings | A warm, compact accent |
| E · Aurora | 8 | A blue-to-teal gradient with a fine directional highlight | A more luminous treatment without a background tile |

Each candidate has a dedicated light and dark SVG. Both preserve the original positions, circle radii, path data, and canvas. Solid uses the exact original colors. The colored dark variants lift color lightness deliberately; they do not invert colors. Gradient definitions use unique IDs. Every SVG has a title and no external resources.

## Deliverables and checks

- Store candidates under `contents/svg/icon-variants/` with `-dark.svg` companions.
- Store the responsive comparison sheet at `contents/html/icon-variants.html`.
- Give the embedded HTML the standard leading `fig` metadata with an English title so documentation compilation and source exports accept it.
- Show every candidate on light and dark surfaces, with 16, 24, and 32 px samples.
- Export a PNG comparison sheet for direct display in chat.
- Check SVG parsing, geometry preservation, loaded images, clipping, and mobile overflow; inspect the rendered large and small marks together.
- Keep the preview usable offline with no scripts, downloads, or dependencies required to view it.

The initial study compared alternatives. The adopted direction above records the user's subsequent selection and its implementation scope.

## Preview

![Icon variants](contents/html/icon-variants.html)

[PNG comparison sheet](contents/png/icon-variants.png)

## Validation

Chromium rendered all 48 sample images and both 1500 px and 375 px layouts without horizontal overflow or page errors. All twelve SVG files, including the original snapshots, parse, have titles and unique local IDs, and retain the original five shapes and viewBox. The preview includes 16, 24, and 32 px samples and twelve SVG download links.

The documentation compiler loaded the two adopted icons without site errors. Generated HTML contains the Solid header mark and theme-specific favicons. Chromium verified the 24 px documentation header, all four shared landing-page marks, and the SaaS favicon's exact original colors in both color schemes. Both SaaS asset-build copies match their source favicon.

The icon compiler and site-icon suites passed all 16 tests. The existing landing-page suite and the application's public-asset test also passed. The video outro was rendered from its original GSAP timeline at the new stroke width; the shipped MP4 decodes successfully and retains 1600 × 900 resolution, 26 fps, 1,818 frames, a 69.932-second duration, and byte-identical audio packets. The surrounding footage was re-encoded when assembling the new outro. Both repositories remain local changes; no deployment or full application test suite was run.
