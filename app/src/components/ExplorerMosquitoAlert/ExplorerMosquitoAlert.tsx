import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import ReactMapGL, { NavigationControl, Popup, useControl } from "react-map-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import ZoomableTimeline from "./timelines/ZoomableTimeline";
import { MapboxOverlay } from "@deck.gl/mapbox";
import "./Explorer.css";
import { GlobalStateContext } from "../../contexts/GlobalStateContext";
import { debounce, throttle } from "lodash";
import useDuckDBTables from "../../hooks/useDuckDBTables";
import { GeoJsonLayer } from "@deck.gl/layers";
import type { Feature } from "geojson";
import toCamelCase from "../../utils/toCamelCase";
import * as d3 from "d3";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import * as h3 from "h3-js";
import { Button, Checkbox, Drawer, Select, Slider, Spin, Segmented } from "antd";
import Label from "../UI/Label";
import { LockFilled, SettingOutlined, UnlockFilled } from "@ant-design/icons";
import useStore from "../../hooks/useStore";
import BrushableTimeline from "./timelines/BrushableTimeline";
import { useQuery } from "@tanstack/react-query";
import CircleLegend from "./legends/CircleLegend";
import SquareLegend from "./legends/SquareLegend";
import Supercluster from "supercluster";
import { ScatterplotLayer } from "@deck.gl/layers/typed";
import colorBrewer from "./colorBrewer";

const INITIAL_VIEW_STATE = {
  longitude: 0.0,
  latitude: 37.7853,
  zoom: 13,
  pitch: 0,
  bearing: 0,
  width: "100%",
  height: "calc(100% - 100px)",
};

const species = ["aedes-albopictus", "aedes-aegypti", "aedes-japonicus", "aedes-koreicus", "culex-pipiens"];

function DeckGLOverlay(props) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

// DeckGL react component
const ExplorerMosquitoAlert = () => {
  const { globalState } = useContext(GlobalStateContext);
  const [h3Resolution, setH3Resolution] = useState(10);
  const [popupInfo, setPopupInfo] = useState();
  const mapRef = useRef();
  const timelineRef = useRef();
  const timelineHeight = 160;
  const [loading, setLoading] = useState(false);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [h3Indexes, setH3Indexes] = useState([]);
  const [presenceLayerOpacity, setPresenceLayerOpacity] = useState(0.01);
  const [mapBounds, setMapBounds] = useState(null);
  const [maxRadiusPixels, setMaxRadiusPixels] = useState(0);
  const [maxRadiusCount, setMaxRadiusCount] = useState(0);
  const [timeBucket, setTimeBucket] = useState("1 month");
  const [timelineData, setTimelineData] = useState([]);
  const [brushableTimelineData, setFullTimelineData] = useState([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(true);
  const [selectedSpecies, setSelectedSpecies] = useState(species);
  const [layerType, setLayerType] = useState("packed-circles");
  const [symbolScale, setSymbolScale] = useState(1);
  const [isH3ResolutionLocked, setIsH3ResolutionLocked] = useState(false);
  const isH3ResolutionLockedRef = useRef(isH3ResolutionLocked);
  const brushableTimelineRef = useRef();
  const setVisibleTimelineDomain = useStore((state) => state.setVisibleTimelineDomain);
  const visibleTimelineDomain = useStore((state) => state.visibleTimelineDomain);
  const [mapReady, setMapReady] = useState(false);
  const [aggregationType, setAggregationType] = useState("h3");
  const [superClusterMaxRadiusPixels, setSuperClusterMaxRadiusPixels] = useState(15);

  useEffect(() => {
    isH3ResolutionLockedRef.current = isH3ResolutionLocked;
  }, [isH3ResolutionLocked]);

  function calculateTimeBucket(density) {
    const base = 0.032;
    if (density > base * 4 * 24 * 7 * 4.2 * 3) return "1 year";
    if (density > base * 4 * 24 * 7 * 4.2) return "3 months";
    if (density > base * 4 * 24 * 7) return "1 month";
    if (density > base * 4 * 24) return "1 week";
    if (density > base * 4) return "1 day";
    return "1 hour";
  }

  const getH3Resolution = useCallback((zoom, latitude = 0, longitude = 0, targetRadiusPixels = 50, min = 0, max = 15) => {
    // Constants for the Earth's radius and tile size
    const earthRadius = 6378137; // in meters
    const tileSize = 512;

    // Calculate the ground resolution at the given latitude and zoom level
    const groundRes = (Math.cos((latitude * Math.PI) / 180) * 2 * Math.PI * earthRadius) / (tileSize * Math.pow(2, zoom));
    // Find the smallest resolution where the edge length in pixels is less than the desired pixel size
    for (let res = min; res <= max; res++) {
      const area = h3.cellArea(h3.latLngToCell(latitude, longitude, res), h3.UNITS.m2);
      const radiusMeters = Math.sqrt(area / Math.PI);
      const radiusPixels = radiusMeters / groundRes;
      if (radiusPixels <= targetRadiusPixels) {
        return res - 1;
      }
    }

    // Return the highest resolution if none are small enough
    return max;
  }, []);

  const getGroundResolution = useCallback((latitude, zoom) => {
    const tileSize = 512;
    return (Math.cos((latitude * Math.PI) / 180) * 2 * Math.PI * 6378137) / (tileSize * Math.pow(2, zoom));
  }, []);

  const getMaxRadius = useCallback((h3Resolution, zoom, latitude = 0, longitude = 0, units) => {
    const groundResolution = getGroundResolution(latitude, zoom);
    const area = h3.cellArea(h3.latLngToCell(latitude, longitude, h3Resolution), h3.UNITS.m2);
    // Calculate the radius in meters from an hexagon with the given area
    const radiusMeters = Math.sqrt((2 * area) / (3 * Math.sqrt(3)));
    const radiusPixels = radiusMeters / groundResolution;

    let scalingFactor = 1;

    if (radiusPixels > 30) scalingFactor = 30 / radiusPixels;

    if (units === "meters") return radiusMeters * scalingFactor * symbolScale;
    if (units === "pixels") return Math.min(radiusPixels, 30) * symbolScale;
  }, []);

  const pointLayer = new GeoJsonLayer({
    id: "point-layer",
    data: features,
    stroked: false,
    filled: true,
    pointType: "circle",
    pickable: false,
    getFillColor: (d) => d.properties.color,
    getRadius: (d) => d.properties.radius,
    opacity: 0.95,
    beforeId: "waterway-label",
  });

  const rectLayer = new GeoJsonLayer({
    id: "stacked-bars-layer",
    data: features,
    stroked: false,
    filled: true,
    pickable: false,
    getFillColor: (d) => d.properties.color,
    getLineWidth: 20,
    opacity: 0.95,
    beforeId: "waterway-label",
  });

  const h3PresenceLayer = new H3HexagonLayer({
    id: "h3-presence-layer",
    data: h3Indexes,
    extruded: false,
    getHexagon: (d) => d.h3Index,
    getLineColor: globalState.theme === "DARK" ? [255, 255, 255, 100] : [0, 0, 0, 100],
    getLineWidth: 0.5,
    lineWidthUnits: "pixels",
    getFillColor: (d) => (globalState.theme === "DARK" ? [255, 255, 255, 100] : [0, 0, 0, 100]),
    pickable: true,
    opacity: presenceLayerOpacity,
    beforeId: "waterway-label",
  });

  const superclusterPresenceLayer = new ScatterplotLayer({
    id: "supercluster-presence-layer",
    data: features.filter((feature) => feature.properties.latitude && feature.properties.longitude).map((d) => d.properties),
    stroked: false,
    filled: true,
    units: "pixels",
    getPosition: (d) => [d.longitude, d.latitude],
    pickable: true,
    getFillColor: (d) => (globalState.theme === "DARK" ? [255, 255, 255, 100] : [0, 0, 0, 100]),
    getLineWidth: 20,
    getRadius: (d) => d.presenceRadius,
    opacity: presenceLayerOpacity,
    beforeId: "waterway-label",
  });

  const layers = [];

  if (aggregationType === "none") {
    layers.push(pointLayer);
  } else {
    if (aggregationType === "h3") layers.push(h3PresenceLayer);
    if (aggregationType === "supercluster") layers.push(superclusterPresenceLayer);
    if (layerType === "stacked-bars") layers.push(rectLayer);
    if (layerType === "packed-circles") layers.push(pointLayer);
  }

  const tableNames = ["all_reports"];
  const { client: duckDBClient, progress: duckDBProgress, isLoading: isDuckDBTablesLoading } = useDuckDBTables(tableNames);
  const { data: dataTimeDomain, isDataTimeDomainLoading } = useQuery(
    ["data-time-domain"],
    async () => {
      const query = `
      SELECT 
        MIN(creation_time::TIMESTAMP) AS min,
        MAX(creation_time::TIMESTAMP) AS max
      FROM 
        all_reports;
    `;
      const data = await duckDBClient.query(query);
      return Object.values(data.toArray().map((row) => row.toJSON())[0])
        .map((d) => d.getTime())
        .sort();
    },
    { enabled: !!duckDBClient },
  );

  useEffect(() => {
    const fetchData = async (duckDBClient) => {
      const mapH3AggregationQuery = `
        WITH GroupedData AS (
          SELECT 
            h3_cell_to_parent(CONCAT('0x', h3_index)::UBIGINT, ${h3Resolution}) AS h3_index,
            ${selectedSpecies.map((species) => `SUM(CASE WHEN class_label = '${species}' THEN 1 ELSE 0 END) AS ${toCamelCase(species)}ReportCount`).join(", ")},
            SUM(CASE WHEN class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) THEN 1 ELSE 0 END) AS totalReportCount,
          FROM 
            all_reports
          WHERE 
            class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) 
            AND creation_time::TIMESTAMP BETWEEN '${visibleTimelineDomain[0].toISOString()}'::TIMESTAMP AND '${visibleTimelineDomain[1].toISOString()}'::TIMESTAMP
            AND h3_cell_to_lat(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLat} AND ${mapBounds.maxLat} 
            AND h3_cell_to_lng(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLng} AND ${mapBounds.maxLng}
          GROUP BY 
            h3_cell_to_parent(CONCAT('0x', h3_index)::UBIGINT, ${h3Resolution})
        )
        SELECT
          h3_cell_to_lat(h3_index) AS latitude,
          h3_cell_to_lng(h3_index) AS longitude,
          h3_cell_area(h3_index, 'km^2') AS cellArea,
          h3_index AS h3Index,
          totalReportCount::INTEGER AS totalReportCount,
          ${selectedSpecies.map((species) => `${toCamelCase(species)}ReportCount::INTEGER as ${toCamelCase(species)}ReportCount`).join(", ")},
          (totalReportCount::FLOAT / cellArea) AS density, -- Calculate total density
        FROM 
          GroupedData;
        `;

      const mapNoAggregationQuery = `
        WITH IndividualData AS (
          SELECT 
            (CONCAT('0x', h3_index)::UBIGINT) AS h3_index,
            class_label,
            h3_cell_to_lat(CONCAT('0x', h3_index)::UBIGINT) AS latitude, -- Add jitter to latitude
            h3_cell_to_lng(CONCAT('0x', h3_index)::UBIGINT) AS longitude, -- Add jitter to longitude
            1 AS report_count
          FROM 
            all_reports
          WHERE 
            class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) 
            AND creation_time::TIMESTAMP BETWEEN '${visibleTimelineDomain[0].toISOString()}'::TIMESTAMP AND '${visibleTimelineDomain[1].toISOString()}'::TIMESTAMP
            AND h3_cell_to_lat(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLat} AND ${mapBounds.maxLat} 
            AND h3_cell_to_lng(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLng} AND ${mapBounds.maxLng}
        )
        SELECT
          latitude,
          longitude,
          h3_index AS h3Index,
          class_label as species,
          report_count
        FROM 
          IndividualData;
      `;

      const timelineQuery = `
        SELECT
            TIME_BUCKET(INTERVAL '${timeBucket}', creation_time::TIMESTAMP) AS start,
            TIME_BUCKET(
                INTERVAL '${timeBucket}',
                TIME_BUCKET(INTERVAL '${timeBucket}', creation_time::TIMESTAMP) + INTERVAL '${timeBucket}'
            ) AS end,
            ${selectedSpecies.map((species) => `SUM(CASE WHEN class_label = '${species}' THEN 1 ELSE 0 END)::INTEGER AS ${toCamelCase(species)}ReportCount`).join(", ")},
            SUM(CASE WHEN class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) THEN 1 ELSE 0 END)::INTEGER AS totalReportCount,
        FROM
            all_reports
        WHERE
            class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) 
            AND creation_time::TIMESTAMP BETWEEN '${visibleTimelineDomain[0].toISOString()}'::TIMESTAMP AND '${visibleTimelineDomain[1].toISOString()}'::TIMESTAMP
            AND h3_cell_to_lat(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLat} AND ${mapBounds.maxLat} 
            AND h3_cell_to_lng(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLng} AND ${mapBounds.maxLng}
        GROUP BY
            TIME_BUCKET(INTERVAL '${timeBucket}', creation_time::TIMESTAMP)
        ORDER BY
            start;
      `;

      console.log(timelineQuery);

      let mapTable;

      console.time("data query");

      if (aggregationType === "none" || aggregationType === "supercluster") {
        mapTable = await duckDBClient.query(mapNoAggregationQuery);
      } else {
        mapTable = await duckDBClient.query(mapH3AggregationQuery);
      }

      console.timeEnd("data query");

      // mapTableArray is redefined later if the aggregation is supercluster
      let mapTableArray = mapTable.toArray().map((row) => row.toJSON());

      const timelineTable = await duckDBClient.query(timelineQuery);
      const timelineData = timelineTable.toArray().map((row) => row.toJSON());

      await setLoading(true);
      const zoom = mapRef.current?.getZoom() || 15;

      console.time("supercluster aggregation");

      if (aggregationType === "supercluster") {
        const index = new Supercluster({
          radius: superClusterMaxRadiusPixels,
          maxZoom: 16,
        });

        index.load(
          mapTableArray.map((row) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [row.longitude, row.latitude],
            },
            properties: row,
          })),
        );

        const clusters = index.getClusters([-180, -85, 180, 85], zoom);
        mapTableArray = clusters.map((cluster) => {
          if (cluster.properties.cluster) {
            const leaves = index.getLeaves(cluster.properties.cluster_id, Infinity);

            const aedesAlbopictusReportCount = leaves.reduce((acc, curr) => acc + (curr.properties.species === "aedes-albopictus" ? 1 : 0), 0);
            const aedesAegyptiReportCount = leaves.reduce((acc, curr) => acc + (curr.properties.species === "aedes-aegypti" ? 1 : 0), 0);
            const aedesJaponicusReportCount = leaves.reduce((acc, curr) => acc + (curr.properties.species === "aedes-japonicus" ? 1 : 0), 0);
            const aedesKoreicusReportCount = leaves.reduce((acc, curr) => acc + (curr.properties.species === "aedes-koreicus" ? 1 : 0), 0);
            const culexPipiensReportCount = leaves.reduce((acc, curr) => acc + (curr.properties.species === "culex-pipiens" ? 1 : 0), 0);

            const totalReportCount =
              aedesAegyptiReportCount + aedesAlbopictusReportCount + aedesJaponicusReportCount + aedesKoreicusReportCount + culexPipiensReportCount;

            return {
              latitude: cluster.geometry.coordinates[1],
              longitude: cluster.geometry.coordinates[0],
              totalReportCount,
              aedesAlbopictusReportCount,
              aedesAegyptiReportCount,
              aedesJaponicusReportCount,
              aedesKoreicusReportCount,
              culexPipiensReportCount,
              supercluster: true,
              cluster: true,
              clusterLength: leaves.length,
            };
          } else {
            return {
              latitude: cluster.geometry.coordinates[1],
              longitude: cluster.geometry.coordinates[0],
              aedesAegyptiReportCount: cluster.properties.species === "aedes-aegypti" ? 1 : 0,
              aedesAlbopictusReportCount: cluster.properties.species === "aedes-albopictus" ? 1 : 0,
              aedesJaponicusReportCount: cluster.properties.species === "aedes-japonicus" ? 1 : 0,
              aedesKoreicusReportCount: cluster.properties.species === "aedes-koreicus" ? 1 : 0,
              culexPipiensReportCount: cluster.properties.species === "culex-pipiens" ? 1 : 0,
              totalReportCount: 1,
              supercluster: true,
              cluster: false,
            };
          }
        });
      }

      console.timeEnd("supercluster aggregation");

      let features: Feature[] = [];
      const latitude = mapRef.current.getCenter().lat;
      const longitude = mapRef.current.getCenter().lng;

      let maxRadiusMeters;
      if (aggregationType === "h3") maxRadiusMeters = getMaxRadius(h3Resolution, zoom, latitude, longitude, "meters");
      if (aggregationType === "supercluster") maxRadiusMeters = superClusterMaxRadiusPixels * getGroundResolution(latitude, zoom);

      let maxRadiusPixels;
      if (aggregationType === "h3") maxRadiusPixels = getMaxRadius(h3Resolution, zoom, latitude, longitude, "pixels");
      if (aggregationType === "supercluster") maxRadiusPixels = superClusterMaxRadiusPixels;

      const maxReportCount = mapTableArray.reduce((acc, curr) => {
        if (curr.totalReportCount > acc) {
          return curr.totalReportCount;
        }
        return acc;
      }, 0);

      if (aggregationType === "none") {
        let radius = 20;
        if (zoom < 5) {
          radius = 5000;
        } else if (zoom < 8) {
          radius = 1500;
        } else if (zoom < 10) {
          radius = 750;
        } else if (zoom < 12) {
          radius = 250;
        } else if (zoom < 14) {
          radius = 50;
        }

        features = mapTableArray.map((row) => {
          const color = speciesColorMap[row.species];
          color.push(200);

          return {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [
                row.longitude + ((Math.random() - 0.5) * 0.0005) / Math.cos((row.latitude * Math.PI) / 180),
                row.latitude + (Math.random() - 0.5) * 0.0005,
              ],
            },
            properties: {
              color,
              species: row.species,
              radius: symbolScale * radius,
            },
          };
        });
      } else if (layerType === "packed-circles") {
        features = mapTableArray
          .map((row) => {
            const metersByLatitudeDegree = 111111;
            const metersByLongitudeDegree = (Math.PI * 6371000 * Math.cos((row.latitude * Math.PI) / 180)) / 180;

            // Tilt the hexagons by 45 degrees
            const angle = Math.PI / 4;

            const radiuses = selectedSpecies
              .map((species) => toCamelCase(species) + "ReportCount")
              .map((key) => {
                return Math.sqrt(row[key] / maxReportCount) * maxRadiusMeters;
              });

            const circlesMeters = d3.packSiblings(radiuses.map((radius) => ({ r: radius }))).map((circle) => ({
              x: Math.cos(angle) * circle.x - Math.sin(angle) * circle.y,
              y: Math.sin(angle) * circle.x + Math.cos(angle) * circle.y,
              r: circle.r,
            }));

            const circlesLatLng = circlesMeters
              .map((circle, index) => {
                const latitude = circle.x / metersByLatitudeDegree + row.latitude;
                const longitude = circle.y / metersByLongitudeDegree + row.longitude;
                const radius = circle.r;
                return { latitude, longitude, radius, index };
              })
              .filter((circle) => circle.radius > 0);

            return circlesLatLng.map((circle, i) => ({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [circle.longitude, circle.latitude],
              },
              properties: {
                color: speciesColorMap[selectedSpecies[circle.index]],
                radius: circle.radius,
                ...(i === 0 ? { ...row } : {}),
                presenceRadius: maxRadiusMeters * 0.5,
              },
            }));
          })
          .flat();
      } else if (layerType === "stacked-bars") {
        features = mapTableArray
          .map((row) => {
            // We need to make sure the squares are projected correctly...
            const metersByLongitudeDegree = (Math.PI * 6371000 * Math.cos((row.latitude * Math.PI) / 180)) / 180;
            const metersByLatitudeDegree = 111111;

            // Calculate the hexagon diameter in latitude degrees
            const maxHeight = maxRadiusMeters / metersByLatitudeDegree;
            const maxWidth = maxRadiusMeters / metersByLongitudeDegree;

            const totalReportCount = row.totalReportCount;

            const height = Math.sqrt(totalReportCount / maxReportCount) * maxHeight * symbolScale;
            const width = Math.sqrt(totalReportCount / maxReportCount) * maxWidth * symbolScale;

            const heights = selectedSpecies
              .map((species) => toCamelCase(species) + "ReportCount")
              .map((key) => {
                return (row[key] * height) / totalReportCount;
              });

            const longitudeOffset = (height - width) / 2;

            // Total height of all stacked rectangles
            const totalHeight = heights.reduce((acc, curr) => acc + curr, 0);

            return heights.map((height, i) => {
              // Calculate the latitude offset to center the rectangle within the hexagon
              const latitudeOffset = heights.slice(0, i).reduce((acc, curr) => acc + curr, 0) - totalHeight / 2;

              return {
                type: "Feature",
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [row.longitude - width / 2 + longitudeOffset, row.latitude + latitudeOffset],
                      [row.longitude + width / 2 + longitudeOffset, row.latitude + latitudeOffset],
                      [row.longitude + width / 2 + longitudeOffset, row.latitude + height + latitudeOffset],
                      [row.longitude - width / 2 + longitudeOffset, row.latitude + height + latitudeOffset],
                    ],
                  ],
                },
                properties: {
                  color: speciesColorMap[selectedSpecies[i]],
                  ...(i === 0 ? { ...row } : {}),
                  presenceRadius: maxRadiusMeters * 0.5,
                },
              };
            });
          })
          .flat();
      }
      const h3Indexes = mapTableArray
        .filter((row) => row.h3Index)
        .map((row) => {
          return { ...row, h3Index: BigInt(row?.h3Index?.toString()).toString(16) };
        });

      return { features, h3Indexes, maxReportCount, maxRadiusMeters, maxRadiusPixels, timelineData };
    };

    if (duckDBClient?.query && mapBounds && visibleTimelineDomain[0] && visibleTimelineDomain[1]) {
      fetchData(duckDBClient).then(({ features, timelineData, h3Indexes, maxReportCount, maxRadiusPixels }) => {
        setFeatures(features);
        setH3Indexes(h3Indexes);
        setMaxRadiusCount(maxReportCount);
        setMaxRadiusPixels(maxRadiusPixels);
        setTimelineData(timelineData);
      });
    }
  }, [duckDBClient, h3Resolution, visibleTimelineDomain, mapBounds, selectedSpecies, symbolScale, layerType, aggregationType]);

  useEffect(() => {
    const fetchData = async (duckDBClient) => {
      // Query the full time range, to display in the brushable timeline
      const brushableTimelineQuery = `
        SELECT
            TIME_BUCKET(INTERVAL '1 week', creation_time::TIMESTAMP) AS start,
            TIME_BUCKET(
                INTERVAL '1 week',
                TIME_BUCKET(INTERVAL '1 week', creation_time::TIMESTAMP) + INTERVAL '1 week'
            ) AS end,
            ${selectedSpecies.map((species) => `SUM(CASE WHEN class_label = '${species}' THEN 1 ELSE 0 END)::INTEGER AS ${toCamelCase(species)}ReportCount`).join(", ")},
            SUM(CASE WHEN class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) THEN 1 ELSE 0 END)::INTEGER AS totalReportCount,
        FROM
            all_reports
        WHERE
            class_label IN (${selectedSpecies.map((species) => `'${species}'`).join(", ")}) 
            AND h3_cell_to_lat(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLat} AND ${mapBounds.maxLat} 
            AND h3_cell_to_lng(CONCAT('0x', h3_index)::UBIGINT) BETWEEN ${mapBounds.minLng} AND ${mapBounds.maxLng}
        GROUP BY
            TIME_BUCKET(INTERVAL '1 week', creation_time::TIMESTAMP)
        ORDER BY
            start;
      `;

      const brushableTimelineTable = await duckDBClient.query(brushableTimelineQuery);
      const brushableTimelineData = brushableTimelineTable.toArray().map((row) => row.toJSON());

      await setLoading(true);

      setLoading(false);
      return { brushableTimelineData };
    };

    if (duckDBClient?.query && mapBounds && visibleTimelineDomain[0] && visibleTimelineDomain[1]) {
      fetchData(duckDBClient).then(({ brushableTimelineData }) => {
        setFullTimelineData(brushableTimelineData);
        setLoading(false);
      });
    }
  }, [duckDBClient, mapBounds, selectedSpecies]);

  useEffect(() => {
    if (mapRef.current) {
      const minLatitude = 10;
      const maxLatitude = 70;
      const minLongitude = -90;
      const maxLongitude = 90;

      if (Number.isNaN(minLongitude + minLatitude + maxLongitude + maxLatitude)) return;

      // Set the bounds initially
      mapRef.current.fitBounds(
        [
          [minLongitude, minLatitude],
          [maxLongitude, maxLatitude],
        ],
        { padding: 50, duration: 1000 },
      );

      // Function to handle zoom changes
      const handleZoom = ({ viewState, target }) => {
        const { transform } = target;
        const { zoom, latitude, longitude } = viewState;
        const min = 0;
        const max = 12;
        const newH3Resolution = getH3Resolution(zoom, latitude, longitude, 15, min, max);
        if (!isH3ResolutionLockedRef.current && newH3Resolution !== h3Resolution) {
          setH3Resolution(newH3Resolution);
        }
        if (mapRef.current && mapRef.current.getBounds) {
          const { _sw, _ne } = mapRef.current.getBounds();
          const maxLat = _ne.lat;
          const minLat = _sw.lat;
          const maxLng = _ne.lng;
          const minLng = _sw.lng;
          onMapBoundsChange({ maxLat, minLat, maxLng, minLng });
        }
      };

      // Function to handle map movements
      const handleMove = () => {
        if (mapRef.current && mapRef.current.getBounds) {
          const { _sw, _ne } = mapRef.current.getBounds();
          const maxLat = _ne.lat;
          const minLat = _sw.lat;
          const maxLng = _ne.lng;
          const minLng = _sw.lng;
          onMapBoundsChange({ maxLat, minLat, maxLng, minLng });
        }
      };

      mapRef.current.on("zoom", handleZoom);
      mapRef.current.on("drag", handleMove);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.off("zoom");
        mapRef.current.off("drag");
      }
    };
  }, [mapReady]);

  useEffect(() => {
    if (features) {
      setFeatures([...features]);
    }
  }, [presenceLayerOpacity]);

  const onTimelineZoom = useCallback(
    throttle(({ density, visibleDomain }) => {
      setTimeBucket((prevTimeBucket) => {
        const newTimeBucket = calculateTimeBucket(density);
        if (newTimeBucket !== prevTimeBucket) {
          return newTimeBucket;
        }
        return prevTimeBucket;
      });
      setVisibleTimelineDomain(visibleDomain);
      brushableTimelineRef.current && brushableTimelineRef.current.setBrushedDomain(visibleDomain);
    }, 100),
    [],
  );

  const onTimelineBrush = useCallback(
    throttle(({ brushedDomain }) => {
      setVisibleTimelineDomain(brushedDomain);
      timelineRef.current && timelineRef.current.setVisibleDomain(brushedDomain);
    }, 100),
    [],
  );

  const onMapBoundsChange = useCallback(
    debounce((newMapBounds) => {
      setMapBounds(newMapBounds);
    }, 500),
    [],
  );

  const mapStyle = globalState.theme === "DARK" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11";

  const paletteHex = colorBrewer.accent;

  const paletteRGB = paletteHex.map((hex) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  });

  const speciesColorMap = {};
  paletteRGB.map((d, i) => (speciesColorMap[species[i]] = d));

  return (
    <div id="explorer-mosquito-alert">
      {isDuckDBTablesLoading && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: 150,
            zIndex: 1000,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Spin spinning={true} />
        </div>
      )}
      <div className="map-container">
        <div
          className={"map-legend"}
          style={{
            position: "absolute",
            top: 60,
            left: 10,
            zIndex: 1000,
            color: globalState.theme === "DARK" ? "#ffffff" : "#000000",
            padding: 10,
            borderRadius: 5,
            fontSize: 12,
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: "bold",
              marginBottom: 5,
            }}
          >
            Species
          </div>
          <div className={"map-legend-item"}>
            <span
              className={"map-legend-item-color"}
              style={{ backgroundColor: paletteHex[0], display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 5 }}
            />
            <span className={"map-legend-item-text"}>Aedes Albopictus</span>
          </div>
          <div className={"map-legend-item"}>
            <span
              className={"map-legend-item-color"}
              style={{ backgroundColor: paletteHex[1], display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 5 }}
            />
            <span className={"map-legend-item-text"}>Aedes Aegypti</span>
          </div>
          <div className={"map-legend-item"}>
            <span
              className={"map-legend-item-color"}
              style={{ backgroundColor: paletteHex[2], display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 5 }}
            />
            <span className={"map-legend-item-text"}>Aedes Japonicus</span>
          </div>
          <div className={"map-legend-item"}>
            <span
              className={"map-legend-item-color"}
              style={{ backgroundColor: paletteHex[3], display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 5 }}
            />
            <span className={"map-legend-item-text"}>Aedes Koreicus</span>
          </div>
          <div className={"map-legend-item"}>
            <span
              className={"map-legend-item-color"}
              style={{ backgroundColor: paletteHex[4], display: "inline-block", width: 10, height: 10, borderRadius: 5, marginRight: 5 }}
            />
            <span className={"map-legend-item-text"}>Culex Pipiens</span>
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            top: 165,
            left: 10,
            zIndex: 1000,
            color: globalState.theme === "DARK" ? "#ffffff" : "#000000",
            padding: 5,
            borderRadius: 5,
            fontSize: 12,
          }}
        >
          {layerType === "packed-circles" && (
            <CircleLegend
              circleColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
              textColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
              title={"Observation counts"}
              ticks={5}
              maxValue={maxRadiusCount}
              maxRadius={maxRadiusPixels}
              width={200}
            />
          )}
          {layerType === "stacked-bars" && (
            <SquareLegend
              squareColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
              textColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
              title={"Observation counts"}
              ticks={5}
              maxValue={maxRadiusCount}
              maxSideLength={maxRadiusPixels}
              width={200}
            />
          )}
        </div>

        <ReactMapGL
          initialViewState={INITIAL_VIEW_STATE}
          mapboxAccessToken={process.env.MAPBOX_ACCESS_TOKEN}
          mapStyle={mapStyle}
          onLoad={() => setMapReady(true)}
          ref={mapRef}
        >
          <DeckGLOverlay
            layers={layers}
            interleaved
            getTooltip={({ object: d }) => {
              if (!d) return null;
              const descriptions = Object.entries(d)
                .filter((d) => d[0].indexOf("ReportCount") !== -1)
                .map((d) => {
                  return [
                    d[0]
                      .replace("ReportCount", "")
                      .replace(/([A-Z])/g, " $1")
                      .toLowerCase()
                      .replace(/^./, (str) => str.toUpperCase())
                      .trim(),
                    d[1],
                  ];
                })
                .map(([name, value]) => `<div>${name}: ${value}</div>`)
                .join("\n");
              return { html: `${descriptions}` };
            }}
          />
          <NavigationControl showCompass={false} />
          {popupInfo && (
            <Popup anchor="top" longitude={Number(popupInfo.longitude)} latitude={Number(popupInfo.latitude)} onClose={() => setPopupInfo(null)}>
              <img width="100%" alt="report" src={popupInfo.picture.data?.attributes.url} />
            </Popup>
          )}
        </ReactMapGL>
        <Button onClick={() => setIsDrawerOpen(true)} style={{ position: "absolute", top: 135, right: 10 }} icon={<SettingOutlined />} />
        <Drawer
          open={isDrawerOpen}
          title={"Parameters"}
          mask={false}
          rootStyle={{ padding: 10, top: 50, height: `calc(100vh - 50px - ${timelineHeight}px)` }}
          onClose={() => setIsDrawerOpen(false)}
        >
          <Label>Species</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }}>
            <Checkbox.Group
              value={selectedSpecies}
              onChange={(values) => {
                if (values.length > 0) {
                  setSelectedSpecies(values);
                }
              }}
              style={{ display: "flex", flexDirection: "column", marginBottom: 16, marginTop: 8 }}
              options={[
                { label: "Aedes albopictus (tiger mosquito)", value: "aedes-albopictus" },
                { label: "Aedes aegypti (yellow fever mosquito)", value: "aedes-aegypti" },
                { label: "Aedes japonicus (asian bush mosquito)", value: "aedes-japonicus" },
                { label: "Aedes koreicus (korean mosquito)", value: "aedes-koreicus" },
                { label: "Culex pipiens (common mosquito)", value: "culex-pipiens" },
              ]}
              name="selectedSpecies"
            />
          </div>
          <Label>Symbol scale</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }}>
            <Slider min={1} max={2} step={0.1} value={symbolScale} onChange={(value) => setSymbolScale(value)} style={{ width: 200 }} />
          </div>
          <div style={{ marginBottom: 8, marginTop: 8 }} key="aggregation-type">
            <Label>Clustering type</Label>
            <Segmented
              style={{ marginTop: 8, marginBottom: 8 }}
              value={aggregationType}
              options={[
                {
                  label: "H3 grid",
                  value: "h3",
                },
                {
                  label: "Supercluster",
                  value: "supercluster",
                },
                {
                  label: "None",
                  value: "none",
                },
              ]}
              onChange={(value) => setAggregationType(value)}
            />
          </div>
          {aggregationType === "h3" && (
            <>
              <Label>H3 resolution</Label>
              <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }}>
                <Slider min={0} max={10} value={h3Resolution} onChange={(value) => setH3Resolution(value)} style={{ width: 200 }} />
                <Button
                  type="link"
                  onClick={() => setIsH3ResolutionLocked((isH3ResolutionLocked) => !isH3ResolutionLocked)}
                  style={{ marginLeft: 8 }}
                  icon={isH3ResolutionLocked ? <LockFilled /> : <UnlockFilled />}
                />
              </div>
            </>
          )}
          {aggregationType !== "none" && (
            <>
              <Label>Presence layer opacity</Label>
              <div style={{ marginBottom: 8, marginTop: 8, width: 200 }} key="hexagon-opacity">
                <Slider min={0} max={1} step={0.01} value={presenceLayerOpacity} onChange={(value) => setPresenceLayerOpacity(value)} />
              </div>
            </>
          )}
          {aggregationType !== "none" && (
            <>
              <Label>Symbol style</Label>
              <div style={{ marginBottom: 8, marginTop: 8 }} key="layer-style">
                <Select
                  style={{ width: "50%", marginTop: 8 }}
                  value={layerType}
                  options={[
                    {
                      label: "Packed circles",
                      value: "packed-circles",
                    },
                    {
                      label: "Stacked bars",
                      value: "stacked-bars",
                    },
                  ]}
                  onChange={(value) => setLayerType(value)}
                />
              </div>
            </>
          )}
        </Drawer>
      </div>
      {dataTimeDomain && (
        <div className="timeline-container">
          <ZoomableTimeline
            ref={timelineRef}
            data={timelineData}
            colorScheme={paletteHex}
            height={120}
            style={{ width: "100%", position: "relative" }}
            domain={dataTimeDomain}
            visibleDomain={dataTimeDomain}
            onZoom={({ density, visibleDomain }) => {
              onTimelineZoom({ visibleDomain, density });
            }}
            theme={globalState.theme}
            onItemClick={() => {}}
          />
          <BrushableTimeline
            ref={brushableTimelineRef}
            data={brushableTimelineData}
            height={40}
            domain={dataTimeDomain}
            colorScheme={paletteHex}
            onBrush={onTimelineBrush}
            brushedDomain={dataTimeDomain}
          />
        </div>
      )}
    </div>
  );
};
export default ExplorerMosquitoAlert;
