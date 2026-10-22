# 初期データの座標出典と限界

`seed.js` は合成デモデータです。地名は公開の施設・地物を参照していますが、段階・開花率などは実際の現地状況ではありません。座標の参照情報は 2026-10-22 時点の保存データに基づき、最新の地物情報を保証しません。

## 公開地物に基づく代表点

| ID | 参照する公開地物 | 取り扱い |
|---|---|---|
| kinchakuda | [OSM way/38231321](https://www.openstreetmap.org/way/38231321) | 巾着田曼珠沙華公園の施設代表点 |
| kitahori | [OSM way/559352244](https://www.openstreetmap.org/way/559352244) | 伏見北堀公園の施設代表点 |
| tofukuji | [OSM way/775463879](https://www.openstreetmap.org/way/775463879) | 東福寺・通天橋の区域代表点 |
| irohazaka | [OSM way/70168811](https://www.openstreetmap.org/way/70168811) | 明智平の駐車場の位置を区域の代表点として利用 |
| gangoji | [OSM way/218642880](https://www.openstreetmap.org/way/218642880) | 元興寺の施設代表点 |

これらは撮影地点や見頃の区域を確認した座標ではありません。公園・寺の中心点を、園内の特定区域の位置とみなしてはいけません。

## 未検証の代表点

`terasaka`、`gongendo`、`fuchu`、`uminaka`、`koidegawa`、`yakachi`、`tsuyagawa`、`sorosenen`、`gyoda`、`hinata`、`asuka`、`tsuzura`、`inunaki` は、区域・区間や施設全体の範囲を確認できていない代表点です。河川・堤・棚田・「周辺」を表す地点は特に、地名だけで観測区域を特定できません。

施設全体と園内の区域は区別し、別名や区域違いは自動統合せず人による確認を求めます。`seed.js` の各地点の `coord_src`、`scope`、区域情報も参照してください。

Data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), licensed under the Open Database License (ODbL). Nominatim usage is subject to its [usage policy](https://operations.osmfoundation.org/policies/nominatim/).
