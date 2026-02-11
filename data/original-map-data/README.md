# Original Map Data

Data from: https://data.london.gov.uk/dataset/statistical-gis-boundary-files-for-london-20od9/

Retrieved 2026/02/11

```sh
$ npm run convert:boundary-data
```

* `statistical-msoa2021-boundaries-london-borough` (8.54 MB) -- in `data/original-map-data/msoa2021`
    * Contains MSOA 2021 boundaries grouped by Boroughs
    * Output to `data/boroughs/[borough-name].geojson`
* `Greater London boundary` (63.27 kB) -- in `data/original-map-data/gla 2`
    * Contains Greater London boundary
    * Output to `data/London_GLA_Boundary.geojson`
