import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import net.bytebuddy.jar.asm.ClassReader;
import net.bytebuddy.jar.asm.ClassVisitor;
import net.bytebuddy.jar.asm.ClassWriter;
import net.bytebuddy.jar.asm.MethodVisitor;
import net.bytebuddy.jar.asm.Opcodes;

/**
 * Maestro 2.11 reads a WebView's DOM over Chrome DevTools, but its WebSocket
 * request carries the socket name as Host ("webview_devtools_remote_<pid>:9222").
 * WebView 15x answers 500 ("Host header is ... not an IP address or localhost"),
 * so Maestro falls back to the accessibility tree. Its HTTP request already sends
 * "Host: localhost:9222"; this adds the same header to the WebSocket request
 * (DadbChromeDevToolsClient.makeSingleWebsocketRequest, after Request.Builder.url).
 *
 * Usage: java -cp byte-buddy.jar MaestroHostPatch.java <in.class> <out.class>
 * (patch-maestro.sh builds a patched copy of the Maestro install; the original is untouched).
 */
public class MaestroHostPatch {
  private static final String BUILDER = "okhttp3/Request$Builder";

  public static void main(String[] args) throws IOException {
    ClassReader reader = new ClassReader(Files.readAllBytes(Path.of(args[0])));
    ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
    int[] patched = {0};
    reader.accept(
        new ClassVisitor(Opcodes.ASM9, writer) {
          @Override
          public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
            MethodVisitor mv = super.visitMethod(access, name, desc, sig, ex);
            if (!name.equals("makeSingleWebsocketRequest")) return mv;
            return new MethodVisitor(Opcodes.ASM9, mv) {
              @Override
              public void visitMethodInsn(int op, String owner, String mName, String mDesc, boolean itf) {
                super.visitMethodInsn(op, owner, mName, mDesc, itf);
                if (owner.equals(BUILDER) && mName.equals("url") && mDesc.equals("(Lokhttp3/HttpUrl;)L" + BUILDER + ";")) {
                  super.visitLdcInsn("Host");
                  super.visitLdcInsn("localhost:9222");
                  super.visitMethodInsn(
                      Opcodes.INVOKEVIRTUAL, BUILDER, "header", "(Ljava/lang/String;Ljava/lang/String;)L" + BUILDER + ";", false);
                  patched[0]++;
                }
              }
            };
          }
        },
        0);
    if (patched[0] != 1) throw new IllegalStateException("expected one Request.Builder.url call, found " + patched[0]);
    Files.write(Path.of(args[1]), writer.toByteArray());
    System.out.println("patched makeSingleWebsocketRequest: Host: localhost:9222");
  }
}
