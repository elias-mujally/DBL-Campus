"""Verify that the package contains the configured API origin and intact web assets."""
import plistlib
import sys
from zipfile import ZipFile

package, origin = sys.argv[1:]
with ZipFile(package) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Archive integrity check failed")
    names = archive.namelist()
    if package.endswith(".apk"):
        assert "AndroidManifest.xml" in names and "classes.dex" in names
        assets = "assets/public/"
    else:
        info = plistlib.loads(archive.read("Payload/App.app/Info.plist"))
        assert info["CFBundleIdentifier"] == "edu.dbl.campus"
        assert "Payload/App.app/" + info["CFBundleExecutable"] in names
        assets = "Payload/App.app/public/"
    assert assets + "index.html" in names
    assert any(origin.encode() in archive.read(name)
               for name in names if name.startswith(assets + "assets/index-") and name.endswith(".js"))
print("Package integrity and bundled API origin verified")
