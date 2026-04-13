# Pitfalls Checklist

Known traps in building a documentation site with diagrams. Each section: symptom, cause, fix, verification.

These were captured from real production work. Don't rediscover them — apply the fixes from the start.

---

## 1. CSS variables in SVG `fill` and `stroke`

### Symptom

Diagrams render blank or with wrong colors in dark mode, even though `getComputedStyle` reports the expected resolved color values.

### Cause

CSS variables used directly in SVG presentation attributes (`fill="var(--x)"`) or inline styles (`style={{fill: 'var(--x)'}}`) do not paint reliably across all loading contexts in Chromium. The variables resolve when queried via JS but the SVG paint pipeline may not honor them, especially when the SVG is loaded as an external file or when there's a hidden specificity conflict with a presentation attribute on the same element.

### Fix

Use **class selectors** instead. CSS variables resolve through class rules consistently because the cascade evaluates them before the paint stage:

```css
:root {
  --dx-primary: #3B6EA8;
}
[data-theme='dark'] {
  --dx-primary: #5A9FFF;
}

.dx-fill-primary { fill: var(--dx-primary); }
.dx-stroke-primary { stroke: var(--dx-primary); }
```

Apply via `className`, never `fill`:

```tsx
// Wrong
<rect fill={`var(--dx-primary)`} />
<rect style={{fill: 'var(--dx-primary)'}} />

// Right
<rect className="dx-fill-primary" />
```

The diagram primitives library exports a `cls` map for this:

```tsx
import { cls } from './tokens';
<rect className={cls.fill.primary} />
```

### Verification

Inspect the rendered DOM via `browser_evaluate`:

```js
const rect = document.querySelector('rect.dx-fill-primary');
console.log(getComputedStyle(rect).fill);
// → rgb(91, 158, 255) in dark mode, rgb(59, 110, 168) in light mode
```

Both modes should produce real RGB values, not the literal string `"var(--dx-primary)"`.

---

## 2. Bulk migration regressions

### Symptom

After running `bulk-fill-migration.py` to convert `fill={colors.X}` to class-based styling:
- TypeScript build fails with `cls is not defined`
- Some elements have stale colors that don't update with theme switching
- Some elements have two `className=` attributes in the source

### Cause

Three known issues with mechanical replacement:

1. **Duplicate `className=`** — elements that already had a `className` attribute end up with two after the migration. JSX silently keeps only the second, which is the original (now-stale) one.
2. **Missing `cls` import** — the migration adds `cls.fill.X` references but doesn't update the import line. Build fails.
3. **Variable-bound fills** — patterns like `fill={labelColor}`, `fill={fillByVariant[variant]}`, or ternary fills are not matched by the script's regex. They stay as hardcoded colors.

### Fix

The script handles issues 1 and 2 automatically:

- **Duplicate `className=`** → merged into a single template literal `className={\`${a} ${b}\`}`
- **Missing `cls` import** → added to any line matching `import { ... } from '...tokens...'`

For issue 3 (variable-bound fills), the script reports them in `needsManualReview` and the user fixes them by hand. Common patterns to fix:

```tsx
// Before
const labelColor = isHighlighted ? colors.primary : colors.text;
<text fill={labelColor}>Label</text>

// After
<text className={isHighlighted ? cls.fill.primary : cls.fill.text}>Label</text>
```

```tsx
// Before
const fillsByVariant = [colors.primary, colors.accent, colors.text];
<rect fill={fillsByVariant[i]} />

// After
const fillClassesByVariant = [cls.fill.primary, cls.fill.accent, cls.fill.text];
<rect className={fillClassesByVariant[i]} />
```

### Verification

Run the migration script with `--dry-run` first to see what will change. After applying, run the build:

```bash
npm run build
```

If the build fails on `cls is not defined`, manually add `cls` to the import line. If the build succeeds but a chapter's diagrams don't theme-switch, check `needsManualReview` from the script output and fix those files by hand.

---

## 3. Playwright viewport screenshot quirks

### Symptom

Playwright viewport-cropped screenshots of diagram regions come back blank, even though the diagrams render correctly when you visit the page in a real browser.

### Cause

Best guess: scroll position and viewport sizing interact in Playwright's screenshot path such that the diagram region falls outside the captured viewport even when the visible browser shows it. Never fully diagnosed — the workaround is sufficient.

### Fix

**Don't trust viewport screenshots for diagram debugging.** Use one of:

1. **Full-page screenshots** (slower but reliable):
   ```js
   await page.screenshot({ fullPage: true });
   ```

2. **DOM inspection via `browser_evaluate`** (fastest, most authoritative):
   ```js
   const rect = document.querySelector('.dx-fill-primary');
   console.log({
     classes: rect.className.baseVal,
     computedFill: getComputedStyle(rect).fill,
     boundingBox: rect.getBoundingClientRect(),
   });
   ```

DOM inspection is the source of truth. If the DOM has the right classes and the computed style has the right resolved color, the diagram is correct — regardless of what a screenshot shows.

### Verification

When in doubt, reload the page in your real browser. Visual confirmation overrides any automated screenshot.

---

## 4. Arrowhead markers don't theme-switch

### Symptom

Arrow lines change color correctly between light and dark modes, but the arrowhead tips stay in light-mode color.

### Cause

SVG `<marker>` elements live in a shadow DOM tree that does not inherit CSS classes from the host document. Class selectors don't apply to marker contents.

### Fix

Two options:

1. **Accept the cosmetic mismatch.** If the arrowhead color is close enough that it doesn't look broken, leave it. This is the simplest path — flag it as known-not-blocking and move on.

2. **Render two markers and switch via media query.** Define separate marker elements for each theme and switch using a CSS media query on `prefers-color-scheme`. More work, but theme-correct.

The Arrow primitive in the library defaults to option 1 — passes a literal `markerColor` hex. Override per-arrow if needed for option 2.

### Verification

Toggle dark mode in the browser. If the arrowheads look "off" against the new background, decide whether to live with it or implement option 2.

---

## 5. Notion exports — nested zips and emoji filenames

### Symptom

When ingesting a Notion export into Phase 2 source gathering:
- The downloaded file is a zip containing another zip
- The standard `unzip` command fails partway through with errors about invalid characters

### Cause

Notion exports two levels deep — the outer zip contains workspace metadata plus an inner zip with the actual page content. The inner zip contains filenames with emoji characters that confuse the standard `unzip` command on macOS and Linux.

### Fix

Use Python's `zipfile` module, which handles Unicode filenames correctly:

```python
import zipfile

# Step 1: extract the outer zip
with zipfile.ZipFile('notion-export.zip', 'r') as outer:
    outer.extractall('extracted/')

# Step 2: find and extract the inner zip
import glob
inner_zips = glob.glob('extracted/**/*.zip', recursive=True)
for inner_zip in inner_zips:
    with zipfile.ZipFile(inner_zip, 'r') as inner:
        inner.extractall('extracted-inner/')
```

### Verification

After extraction, check that you have a flat directory of markdown files with their attachment folders. The filenames should preserve their emoji characters (e.g., `🏗 Architecture.md`), not become garbled.

Move the extracted files to `.claude-scratchpad/` for working access, not shared context. They're raw material, not source of truth.

---

## When to update this checklist

If you encounter a new pitfall while running this skill, add it here with the same five-section format (symptom, cause, fix, verification, when to update). The point of this file is to prevent rediscovery — every captured pitfall saves the next person hours.
