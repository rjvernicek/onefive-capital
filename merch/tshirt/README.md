# OneFive tee

![mockup](mockup.png)

| File | Placement | Size | Ink |
|---|---|---|---|
| `front-street-sign.svg` | Front, centred chest, ~3.5in below collar | 11in × 4in | Green `#00704A` (PMS 3415 C), white |
| `back-yoke-onefive.svg` | Back, centre yoke, ~1in below collar seam | 4in × 0.8in | Green `#00704A` |

The front recreates a Philadelphia street blade: a green rounded rectangle with a white border, the Liberty Bell mark, the block-number band (`← 1500 S 1600 →`) and **15TH ST** with the raised "TH". 15th Street = OneFive. Everything white knocks out of the green, so on a white or natural tee it can print as one colour.

All text is converted to outlines — no fonts needed to print. Shown on a natural tee.

## Regenerating

`gen.py` builds both SVGs from Overpass Bold/ExtraBold (SIL OFL, a free road-sign face close to the Clearview the city uses); `mock.py` builds `mockup.svg`.

```sh
pip install fonttools
mkdir fonts && curl -L -o fonts/Overpass.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/overpass/Overpass%5Bwght%5D.ttf"
python3 -m fontTools.varLib.instancer fonts/Overpass.ttf wght=700 -o fonts/Overpass-Bold.ttf
python3 -m fontTools.varLib.instancer fonts/Overpass.ttf wght=800 -o fonts/Overpass-XB.ttf
python3 gen.py . && python3 mock.py .
```
