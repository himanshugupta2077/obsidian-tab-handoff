import { FileView, MarkdownView, TFile, View } from "obsidian";

/** Reads and sets the position in one kind of view, in units that are the same on every screen size. */
export interface Reader {
	view: FileView;
	file: TFile;
	/** Smallest difference worth acting on, in this reader's units. */
	epsilon: number;
	/** Current position, or null while the view is still loading. */
	get(): number | null;
	/** Returns false if the view isn't ready yet. */
	set(pos: number): boolean;
}

export function readerFor(view: View | null): Reader | null {
	if (view instanceof MarkdownView && view.file) return markdownReader(view, view.file);
	if (view instanceof FileView && view.file && view.getViewType() === "pdf") return pdfReader(view, view.file);
	return null;
}

// Markdown: the top visible line (fractional), in reading view and editing view alike.
function markdownReader(view: MarkdownView, file: TFile): Reader {
	return {
		view,
		file,
		epsilon: 1,
		get() {
			const s = view.getEphemeralState().scroll;
			if (typeof s === "number") return s;
			const m = view.currentMode.getScroll();
			return typeof m === "number" ? m : null;
		},
		set(scroll) {
			view.setEphemeralState({ scroll });
			return true;
		},
	};
}

// The PDF viewer isn't in the public API. This is PDF.js's viewer, which Obsidian embeds.
interface PdfJsViewer {
	pagesCount: number;
	currentPageNumber: number;
	container: HTMLElement;
	getPageView(index: number): { div: HTMLElement } | undefined;
}

// PDF: page index plus how far down that page you are, so 11.5 is halfway down page 12.
function pdfReader(view: FileView, file: TFile): Reader {
	const viewer = (): PdfJsViewer | null => {
		const pv = (view as unknown as { viewer?: { child?: { pdfViewer?: { pdfViewer?: PdfJsViewer } } } }).viewer?.child?.pdfViewer?.pdfViewer;
		return pv && pv.pagesCount > 0 ? pv : null;
	};
	return {
		view,
		file,
		epsilon: 0.05,
		get() {
			const pv = viewer();
			if (!pv) return null;
			const page = pv.currentPageNumber;
			const div = pv.getPageView(page - 1)?.div;
			if (!div?.offsetHeight) return page - 1;
			const frac = (pv.container.scrollTop - div.offsetTop) / div.offsetHeight;
			return page - 1 + Math.min(Math.max(frac, 0), 0.999);
		},
		set(pos) {
			const pv = viewer();
			if (!pv) return false;
			const index = Math.min(Math.floor(pos), pv.pagesCount - 1);
			pv.currentPageNumber = index + 1;
			const div = pv.getPageView(index)?.div;
			if (div?.offsetHeight) pv.container.scrollTop = div.offsetTop + (pos - index) * div.offsetHeight;
			return true;
		},
	};
}
