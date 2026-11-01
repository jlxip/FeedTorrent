from pathlib import Path
import hashlib,re,json

ROOT=Path(__file__).resolve().parent
SOURCE=ROOT/'src/mockup.html'
fragment=SOURCE.read_text()
basecoat=(ROOT/'vendor/basecoat-vega-1.0.2.min.css').read_text()
icons=(ROOT/'vendor/lucide-0.468.0.min.js').read_text()
basecoat=re.sub(r'/\*# sourceMappingURL=.*?\*/','',basecoat)
icons=re.sub(r'//# sourceMappingURL=.*','',icons)
icons=re.sub(r'</script',r'<\\/script',icons,flags=re.I)
licenses=(ROOT/'vendor/BASECOAT-LICENSE.md').read_text()+'\n'+(ROOT/'vendor/LUCIDE-LICENSE').read_text()
assert '-->' not in licenses
csp="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
theme="const appearance=matchMedia('(prefers-color-scheme: dark)');function followAppearance(){document.documentElement.classList.toggle('dark',appearance.matches)}followAppearance();appearance.addEventListener('change',followAppearance);"
document='''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="'''+csp+'''">
<title>FeedTorrent</title>
<!-- Static UX prototype. Basecoat CSS 1.0.2 (Vega), MIT; Lucide 0.468.0, ISC.\n'''+licenses+'''\n-->
<style>'''+basecoat+'''\nhtml,body{margin:0;padding:0;width:100%;min-height:100%;scroll-behavior:auto}body{background:var(--background);color:var(--foreground)}</style>
<script>'''+theme+'''</script>
<script>'''+icons+'''</script>
</head>
<body>
'''+fragment+'''
</body>
</html>
'''
assert '<iframe' not in document
assert not re.search(r'<(?:script|link)\b[^>]*(?:src|href)\s*=',document,re.I)
assert len(document.encode())<1_000_000
(ROOT/'index.html').write_text(document)
print(json.dumps({'bytes':len(document.encode()),'sha256':hashlib.sha256(document.encode()).hexdigest(),'source_sha256':hashlib.sha256(fragment.encode()).hexdigest(),'basecoat':'1.0.2 Vega','lucide':'0.468.0','external_runtime_assets':0},indent=2))
