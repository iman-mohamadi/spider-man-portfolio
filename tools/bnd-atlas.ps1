# Dev-only: packs the Brand New Day UDIM tiles (Textures.zip, read only) into one 3 x 2 atlas per material set at 1024 px per tile; see tools/bnd-lab.html.
# Usage: powershell -File tools/bnd-atlas.ps1 -ZipPath <Textures.zip> -OutDir content/spider-bnd/tex
param([string]$ZipPath, [string]$OutDir, [int]$T = 1024)
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.IO; using System.IO.Compression;
public static class Atlas {
  public static Bitmap Tile(ZipArchive z, string name, int T) {
    var e = z.GetEntry("Textures/" + name + ".png"); if (e == null) return null;
    var ms = new MemoryStream(); using (var s = e.Open()) s.CopyTo(ms); ms.Position = 0;
    using (var src = Image.FromStream(ms)) {
      var bmp = new Bitmap(T, T, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.SmoothingMode = SmoothingMode.HighQuality; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.CompositingMode = CompositingMode.SourceCopy;
        using (var ia = new ImageAttributes()) { ia.SetWrapMode(WrapMode.TileFlipXY); g.DrawImage(src, new Rectangle(0, 0, T, T), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia); }
      }
      return bmp;
    }
  }
  public static byte[] Bytes(Bitmap b, out int stride) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb); stride = d.Stride;
    var arr = new byte[d.Stride * b.Height]; System.Runtime.InteropServices.Marshal.Copy(d.Scan0, arr, 0, arr.Length); b.UnlockBits(d); return arr;
  }
  public static void Put(Bitmap atlas, Bitmap tile, int cx, int cy, int T) {
    using (var g = Graphics.FromImage(atlas)) { g.CompositingMode = CompositingMode.SourceCopy; g.DrawImageUnscaled(tile, cx * T, cy * T); }
  }
  // tiles (rgb of `rgb`, alpha from the red channel of `alpha` when given)
  public static Bitmap WithAlpha(Bitmap rgb, Bitmap alpha) {
    int s1, s2; var a = Bytes(rgb, out s1); var b = Bytes(alpha, out s2); int n = rgb.Width * rgb.Height;
    for (int y = 0; y < rgb.Height; y++) for (int x = 0; x < rgb.Width; x++) { a[y * s1 + x * 4 + 3] = b[y * s2 + x * 4 + 2]; }
    var o = new Bitmap(rgb.Width, rgb.Height, PixelFormat.Format32bppArgb); var d = o.LockBits(new Rectangle(0, 0, o.Width, o.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    System.Runtime.InteropServices.Marshal.Copy(a, 0, d.Scan0, a.Length); o.UnlockBits(d); return o;
  }
  // glTF metallic-roughness: R = 255, G = roughness, B = metallic
  public static Bitmap Pack(Bitmap rough, Bitmap metal) {
    int s1, s2; var r = Bytes(rough, out s1); var m = Bytes(metal, out s2);
    var o = new Bitmap(rough.Width, rough.Height, PixelFormat.Format32bppArgb); var d = o.LockBits(new Rectangle(0, 0, o.Width, o.Height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
    var res = new byte[d.Stride * o.Height];
    for (int y = 0; y < o.Height; y++) for (int x = 0; x < o.Width; x++) { int i = y * d.Stride + x * 4; res[i + 2] = 255; res[i + 1] = r[y * s1 + x * 4 + 2]; res[i] = m[y * s2 + x * 4 + 2]; res[i + 3] = 255; }
    System.Runtime.InteropServices.Marshal.Copy(res, 0, d.Scan0, res.Length); o.UnlockBits(d); return o;
  }
  public static double Mean(Bitmap b) { int s; var a = Bytes(b, out s); double t = 0; for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) t += a[y * s + x * 4 + 2]; return t / (b.Width * b.Height); }
  public static void SaveJpg(Bitmap b, string path, long q) {
    var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg"); var p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
    using (var flat = new Bitmap(b.Width, b.Height, PixelFormat.Format24bppRgb)) { using (var g = Graphics.FromImage(flat)) g.DrawImageUnscaled(b, 0, 0); flat.Save(path, codec, p); }
  }
}
'@ -ReferencedAssemblies System.Drawing, System.IO.Compression, System.IO.Compression.FileSystem

New-Item -ItemType Directory -Force $OutDir | Out-Null
$zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
$W = 3 * $T; $H = 2 * $T
# placement of each UDIM tile in the 3 x 2 grid (column, row from the top)
$suitTiles = @{ '1001' = @(0,0); '1002' = @(1,0); '1003' = @(2,0); '1004' = @(0,1); '1005' = @(1,1) }
$accTiles  = @{ '1001' = @(0,0); '1002' = @(1,0); '1003' = @(2,0); '1011' = @(0,1); '1012' = @(1,1) }

function Build($set, $tiles, $alpha) {
  $base = New-Object Drawing.Bitmap $W, $H, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $norm = New-Object Drawing.Bitmap $W, $H, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $mr   = New-Object Drawing.Bitmap $W, $H, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
  foreach ($k in $tiles.Keys) {
    $c = $tiles[$k][0]; $r = $tiles[$k][1]
    $b = [Atlas]::Tile($zip, "${set}_BaseColor.$k", $T)
    if ($alpha) { $a = [Atlas]::Tile($zip, "${set}_Alpha.$k", $T); "{0} alpha {1} mean(R) = {2:N1}" -f $set, $k, [Atlas]::Mean($a); $b2 = [Atlas]::WithAlpha($b, $a); $b.Dispose(); $a.Dispose(); $b = $b2 }
    [Atlas]::Put($base, $b, $c, $r, $T); $b.Dispose()
    $n = [Atlas]::Tile($zip, "${set}_Normal.$k", $T); [Atlas]::Put($norm, $n, $c, $r, $T); $n.Dispose()
    $ro = [Atlas]::Tile($zip, "${set}_Roughness.$k", $T); $me = [Atlas]::Tile($zip, "${set}_Metallic.$k", $T)
    $p = [Atlas]::Pack($ro, $me); [Atlas]::Put($mr, $p, $c, $r, $T); $ro.Dispose(); $me.Dispose(); $p.Dispose()
    "{0} tile {1} done" -f $set, $k
  }
  $lc = $set.ToLower()
  if ($alpha) { $base.Save((Join-Path $OutDir "${lc}_base.png"), [Drawing.Imaging.ImageFormat]::Png) } else { [Atlas]::SaveJpg($base, (Join-Path $OutDir "${lc}_base.jpg"), 90) }
  [Atlas]::SaveJpg($norm, (Join-Path $OutDir "${lc}_normal.jpg"), 92)
  [Atlas]::SaveJpg($mr, (Join-Path $OutDir "${lc}_mr.jpg"), 90)
  $base.Dispose(); $norm.Dispose(); $mr.Dispose()
}
Build 'Suit' $suitTiles $false
Build 'Acc' $accTiles $true
$zip.Dispose()
Get-ChildItem $OutDir | ForEach-Object { '{0,-20} {1,10:N0}' -f $_.Name, $_.Length }
