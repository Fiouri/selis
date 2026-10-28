package android.print;

import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;

/**
 * Drives a {@link PrintDocumentAdapter} without the system print dialog (ADR 0035):
 * layout, then write every page to a file descriptor. The adapter's result callbacks
 * have package-private constructors, so they can only be subclassed from this
 * package; this class does only that. ART logs the constructors as non-SDK
 * ("unsupported", linking) and allows them; if a future Android blocks them, the
 * first call throws a LinkageError, ConvertPlugin reports "unsupported" and the
 * conversion entry points hide.
 */
public final class PrintCallbacks {
    /** Called once: with no error when the PDF is complete, else with the reason. */
    public interface Done {
        void done(String error);
    }

    private PrintCallbacks() {}

    /**
     * Links the callbacks' constructors once without printing: false when this Android
     * refuses them, so the UI can hide conversion instead of failing later.
     */
    public static boolean available() {
        try {
            new PrintDocumentAdapter.LayoutResultCallback() {};
            new PrintDocumentAdapter.WriteResultCallback() {};
            return true;
        } catch (LinkageError e) {
            return false;
        }
    }

    public static void print(
            final PrintDocumentAdapter adapter,
            final PrintAttributes attributes,
            final ParcelFileDescriptor output,
            final Done done) {
        final CancellationSignal cancel = new CancellationSignal();
        adapter.onStart();
        adapter.onLayout(null, attributes, cancel, new PrintDocumentAdapter.LayoutResultCallback() {
            @Override
            public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                adapter.onWrite(new PageRange[] {PageRange.ALL_PAGES}, output, cancel, new PrintDocumentAdapter.WriteResultCallback() {
                    @Override
                    public void onWriteFinished(PageRange[] pages) {
                        adapter.onFinish();
                        done.done(pages == null || pages.length == 0 ? "no pages written" : null);
                    }

                    @Override
                    public void onWriteFailed(CharSequence error) {
                        adapter.onFinish();
                        done.done(error == null ? "write failed" : error.toString());
                    }

                    @Override
                    public void onWriteCancelled() {
                        adapter.onFinish();
                        done.done("write cancelled");
                    }
                });
            }

            @Override
            public void onLayoutFailed(CharSequence error) {
                adapter.onFinish();
                done.done(error == null ? "layout failed" : error.toString());
            }

            @Override
            public void onLayoutCancelled() {
                adapter.onFinish();
                done.done("layout cancelled");
            }
        }, new Bundle());
    }
}
