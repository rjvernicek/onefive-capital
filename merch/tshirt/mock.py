import re,sys
d=sys.argv[1]
def inner(f):
    s=open(f"{d}/{f}").read()
    return re.search(r'<svg[^>]*>(.*)</svg>',s,re.S).group(1)
front,yoke=inner("front-street-sign.svg"),inner("back-yoke-onefive.svg")
TEE="M150,60 C190,48 230,40 250,36 C270,70 330,70 350,36 C370,40 410,48 450,60 L560,140 L500,230 L450,200 L450,640 C350,655 250,655 150,640 L150,200 L100,230 L40,140 Z"
def tee(x,label,art,back):
    collar = ('<path d="M250,36 C270,70 330,70 350,36" fill="none" stroke="#bdb6a8" stroke-width="5"/>' if not back
              else '<path d="M250,36 C275,48 325,48 350,36" fill="none" stroke="#bdb6a8" stroke-width="5"/>')
    return f'''<g transform="translate({x},20)">
 <path d="{TEE}" fill="#F4F1EA" stroke="#cfc8ba" stroke-width="2"/>{collar}
 {art}
 <text x="300" y="700" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#555">{label}</text></g>'''
# front: 12in sign -> 240px wide on 600px tee (approx 20px/in)
fa=f'<g transform="translate(190,165) scale(0.2)">{front}</g>'
ya=f'<g transform="translate(260,72) scale(0.2)">{yoke}</g>'
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1240 740" width="1240" height="740">
<rect width="1240" height="740" fill="#ffffff"/>
{tee(10,"FRONT — 15TH ST blade, 11in wide, centred chest",fa,False)}
{tee(630,"BACK — OneFive wordmark, centre yoke",ya,True)}
</svg>'''
open(f"{d}/mockup.svg","w").write(svg)
