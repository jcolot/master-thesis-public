import React, { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import ReactMapGL, { NavigationControl, useControl } from "react-map-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import ZoomableTimeline from "./timelines/ZoomableTimeline";
import { MapboxOverlay } from "@deck.gl/mapbox";
import "./Explorer.css";
import { GlobalStateContext } from "../../contexts/GlobalStateContext";
import { debounce, throttle } from "lodash";
import useDuckDBTables from "../../hooks/useDuckDBTables";
import type { Feature } from "geojson";
import * as d3 from "d3";
import dayjs from "dayjs";
import * as h3 from "h3-js";
import { Button, DatePicker, Drawer, Radio, Segmented, Select, Slider, Space, Spin } from "antd";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers/typed";
import { useQuery } from "@tanstack/react-query";
import Label from "../UI/Label";
import useStore from "../../hooks/useStore";
import BrushableTimeline from "./timelines/BrushableTimeline";
import { colorSchemeOptions, colorSchemeLabel } from "./legends/colorsScheme";
import ColorLegend from "./legends/ColorLegend";
import utc from "dayjs/plugin/utc";
import customParseFormat from "dayjs/plugin/customParseFormat";
import isoWeek from "dayjs/plugin/isoWeek";
import CircleLegend from "../ExplorerCovid19/legends/CircleLegend";
import TimeLegend from "./legends/TimeLegend";
// @ts-ignore
import scaleCluster from "d3-scale-cluster";
import { SettingOutlined } from "@ant-design/icons";

dayjs.extend(utc);
dayjs.extend(isoWeek);

const indicatorMap = {
  hosp: "Hospitalized patients",
  incid_hosp: "Newly hospitalized patients (24h)",
  dchosp: "Hospital deaths (total)",
  incid_dchosp: "Hospital deaths (24h)",
  rea: "ICU hospitalization",
  incid_rea: "Newly ICU hospitalized patients (24h)",
};

dayjs.extend(customParseFormat);

const INITIAL_PARIS_MAP_STATE = {
  longitude: 0.41669,
  latitude: 55.7853,
  zoom: 10,
  pitch: 0,
  bearing: 0,
  width: 400,
  height: 400,
};

const INITIAL_FRANCE_MAP_STATE = {
  longitude: 0.41669,
  latitude: 55.7853,
  zoom: 10,
  pitch: 0,
  bearing: 0,
  width: "100%",
  height: "calc(100% - 160px)",
};

function DeckGLOverlay(props) {
  const overlay = useControl(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

const DatePickerWithArrows = forwardRef(function DatePickerWithArrows({ value, onChange, period, ...restProps }, ref) {
  const [date, setDate] = useState(value);
  useEffect(() => {
    setDate(value);
  }, [value]);

  // Use useImperativeHandle to expose any internal functions you might need
  useImperativeHandle(ref, () => ({
    updateDate: (newDate) => {},
    setValue: (newValue) => {
      setDate(newValue);
    },
  }));
  return (
    <div style={{ display: "flex", justifyContent: "left", alignItems: "center" }}>
      <DatePicker
        value={date}
        onChange={onChange}
        minDate={dayjs("2020-03-01", "YYYY-MM-DD")}
        maxDate={dayjs("2023-10-31", "YYYY-MM-DD")}
        picker={period}
      />
      <Space style={{ marginLeft: 8 }}>
        <Radio.Group>
          <Radio.Button style={{ height: 30 }} onClick={() => onChange(value.add(-1, period))}>
            {"<"}
          </Radio.Button>
          <Radio.Button style={{ height: 30 }} onClick={() => onChange(value.add(1, period))}>
            {">"}
          </Radio.Button>
        </Radio.Group>
      </Space>
    </div>
  );
});

// DeckGL react component
const ExplorerCovid19 = () => {
  const { globalState } = useContext(GlobalStateContext);
  const [h3Resolution, setH3Resolution] = useState(6);
  const timelineHeight = 160;
  const [selectedDate, setSelectedDate] = useState(dayjs("2020-03-20", "YYYY-MM-DD"));
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [h3Features, setH3Features] = useState<Feature[]>([]);
  const [choroplethFeatures, setChoroplethFeatures] = useState<Feature[]>([]);
  const [choroplethOpacity, setChoroplethOpacity] = useState(0.01);
  const [h3Opacity, setH3Opacity] = useState(1);
  const [timeBucket, setTimeBucket] = useState("1 week");
  const [timelineData, setTimelineData] = useState([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(true);
  const [selectedIndicator, setSelectedIndicator] = useState("hosp");
  const [autoplay, setAutoplay] = useState(false);
  const [radiusScale, setRadiusScale] = useState(5);
  const [maxRadiusPixels, setMaxRadiusPixels] = useState();
  const [maxPop, setMaxPop] = useState();
  const mapRef = useRef();
  const timelineRef = useRef();
  const [strokeWidth, setStrokeWidth] = useState(1);
  const brushableTimelineRef = useRef();
  const setVisibleTimelineDomain = useStore((state) => state.setVisibleTimelineDomain);
  const visibleTimelineDomain = useStore((state) => state.visibleTimelineDomain);
  const setMapBounds = useStore((state) => state.setMapBounds);
  const mapBounds = useStore((state) => state.mapBounds);
  const [colorSchemeCapping, setColorSchemeCapping] = useState(0.5);
  const [selectedDepartmentNumber, setSelectedDepartmentNumber] = useState("all");
  const [mapTypeQuickControl, setMapTypeQuickControl] = useState("custom");
  const h3ResolutionRef = useRef(h3Resolution);

  const [colorScheme, setColorScheme] = useState("Reds");

  useEffect(() => {
    if (mapTypeQuickControl !== "choropleth" && choroplethOpacity === 1 && h3Opacity === 0) {
      setMapTypeQuickControl("choropleth");
    }
    if (mapTypeQuickControl !== "h3" && choroplethOpacity === 0 && h3Opacity === 1) {
      setMapTypeQuickControl("h3");
    }

    if ((mapTypeQuickControl !== undefined && choroplethOpacity !== 0 && choroplethOpacity !== 1) || (h3Opacity !== 1 && h3Opacity !== 0)) {
      setMapTypeQuickControl(undefined);
    }
  }, [choroplethOpacity, h3Opacity, mapTypeQuickControl]);

  useEffect(() => {
    h3ResolutionRef.current = h3Resolution;
  }, [h3Resolution]);

  const { data: departmentsGeoJSON, isLoading: isFeaturesLoading } = useQuery(["departments"], async () => {
    const response = await fetch(`${window.location.origin}/departments_fr.geojson`);
    const data = await response.json();
    return data;
  });

  const debouncedSetMaxRadiusPixels = useCallback(debounce(setMaxRadiusPixels, 100, { leading: true, trailing: true }), []);

  useEffect(() => {
    let intervalId = null;
    if (autoplay) {
      intervalId = setInterval(() => {
        const period = timeBucket.split(" ")[1];
        setSelectedDate((prevDate) => {
          const utcPrevDate = dayjs.utc(prevDate);

          if (utcPrevDate.isBefore(dayjs.utc("2023-06-30", "YYYY-MM-DD"))) {
            return utcPrevDate.add(1, period).startOf(period === "week" ? "isoWeek" : period);
          } else {
            return dayjs.utc("2020-03-20", "YYYY-MM-DD").startOf(period === "week" ? "isoWeek" : period);
          }
        });
      }, 200);
    } else {
      clearInterval(intervalId);
    }
    return () => clearInterval(intervalId);
  }, [autoplay, timeBucket]);

  const handleAutoplayToggle = () => {
    setH3Resolution((prev) => (prev === 7 ? 6 : prev));
    setAutoplay(!autoplay);
  };

  function calculateTimeBucket(density) {
    const base = 0.032;
    if (density > base * 4 * 24 * 7 * 4.2 * 3) return "1 year";
    if (density > base * 4 * 24 * 7 * 4.2) return "3 months";
    if (density > base * 4 * 24 * 7) return "1 month";
    if (density > base * 4 * 24) return "1 week";
    if (density > base * 4) return "1 day";
    return "1 day";
  }

  function calculateDatetimeFormat(timeBucket) {
    switch (timeBucket) {
      case "1 year":
        return "YYYY";
      case "3 months":
        return "YYYY-MM";
      case "1 month":
        return "YYYY-MM";
      case "1 week":
        return "YYYY-MM-DD";
      case "1 day":
        return "YYYY-MM-DD";
      case "1 hour":
        return "YYYY-MM-DD HH:mm";
      case "15 minutes":
        return "YYYY-MM-DD HH:mm";
      default:
        return "YYYY-MM-DD HH:mm";
    }
  }

  const getMaxRadius = useCallback((h3Resolution, zoom, latitude = 0, longitude = 0, units) => {
    const earthRadius = 6378137; // in meters
    const tileSize = 512;
    const groundRes = (Math.cos((latitude * Math.PI) / 180) * 2 * Math.PI * earthRadius) / (tileSize * Math.pow(2, zoom));
    const area = h3.cellArea(h3.latLngToCell(latitude, longitude, h3Resolution), h3.UNITS.m2);
    const radiusMeters = Math.sqrt(area / Math.PI);
    const radiusPixels = radiusMeters / groundRes;

    if (units === "meters") return radiusMeters;
    if (units === "pixels") return radiusPixels;
  }, []);

  const scatterplotLayer = new ScatterplotLayer({
    id: "scatterplot-layer",
    data: h3Features,
    opacity: h3Opacity,
    stroked: true,
    filled: true,
    pointType: "circle",
    offsetUnits: "meters",
    pickable: true,
    getLineColor: globalState.theme === "DARK" ? [255, 255, 255, 50] : [0, 0, 0, 50],
    lineWidthMinPixels: 0.7,
    getRadius: (d) => d.properties.radius * radiusScale,
    getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
    getFillColor: (d) => {
      if (d.properties.departmentNumber !== selectedDepartmentNumber && selectedDepartmentNumber !== "all") return [255, 255, 255, 0];
      const color = Object.values(d3.rgb(colorScale(d.properties.indicatorRate)));
      color[3] = color[3] * 255;
      return color;
    },
    getTextSize: 12,
    beforeId: "waterway-label",
  });

  const choroplethLayer = new GeoJsonLayer({
    id: "geojson-layer",
    data: choroplethFeatures,
    stroked: true,
    filled: true,
    lineWidthMinPixels: 1,
    opacity: choroplethOpacity,
    getLineColor: [255, 255, 255, 100],
    getFillColor: (d) => {
      if (d.properties.departmentNumber !== selectedDepartmentNumber && selectedDepartmentNumber !== "all") return [255, 255, 255, 0];
      const color = Object.values(d3.rgb(colorScale(d.properties.indicatorRate)));
      color[3] = color[3] * 255;
      return color;
    },
    beforeId: "waterway-label",
  });

  const layers = [choroplethLayer, scatterplotLayer];
  const tableNames = ["pop_fr", "covid_indicators", "census_departments"];
  const { client: duckDBClient, progress: duckDBProgress, isLoading: isDuckDBTablesLoading } = useDuckDBTables(tableNames);

  const { data: brushableTimelineData, isLoading: isFullTimelineDataLoading } = useQuery(
    ["brushable-timeline-data", selectedIndicator, selectedDepartmentNumber],
    async () => {
      const brushableTimelineQuery = `
        SELECT
            TIME_BUCKET(INTERVAL '1 day', date::TIMESTAMP) AS start,
            TIME_BUCKET(
                INTERVAL '1 day',
                TIME_BUCKET(INTERVAL '1 day', date::TIMESTAMP) + INTERVAL '1 day'
            ) AS end,
            SUM(${selectedIndicator})::INT AS indicator,
        FROM covid_indicators 
        ${selectedDepartmentNumber !== "all" ? `WHERE department_number = '${selectedDepartmentNumber}'` : ""}
        GROUP BY
            TIME_BUCKET(INTERVAL '1 day', date::TIMESTAMP)
        ORDER BY
            start;
        `;

      const brushableTimelineTable = await duckDBClient.query(brushableTimelineQuery);
      const brushableTimelineData = brushableTimelineTable.toArray().map((row) => row.toJSON());
      return brushableTimelineData;
    },
    { enabled: !!duckDBClient, cacheTime: Infinity, staleTime: Infinity },
  );

  const { data: timelineDomain, isLoading: isTimelineDomainLoading } = useQuery(
    ["timeline-domain"],
    async () => {
      const timelineDomainQuery = `
        SELECT
          MIN(date::TIMESTAMP) AS min,
          MAX(date::TIMESTAMP + INTERVAL '1 day') AS max,
        FROM covid_indicators 
      `;

      const minMaxDatesTable = await duckDBClient.query(timelineDomainQuery);
      const minMaxDates = minMaxDatesTable.toArray().map((row) => row.toJSON())[0];
      return Object.values(minMaxDates);
    },
    { enabled: !!duckDBClient, cacheTime: Infinity, staleTime: Infinity },
  );

  const { data: departmentList, isLoading: isDepartmentListLoading } = useQuery(
    ["department-list"],
    async () => {
      const departmentListQuery = `
        SELECT department_number AS departmentNumber, department_name AS departmentName
        FROM census_departments 
        WHERE LEFT(department_number, 2) != '97'
      `;

      const departmentList = await duckDBClient.query(departmentListQuery);
      return departmentList.toArray().map((row) => row.toJSON());
    },
    { enabled: !!duckDBClient, cacheTime: Infinity, staleTime: Infinity },
  );

  const { data: maximumIndicators } = useQuery(
    ["maximum-indicators", selectedDepartmentNumber],
    async () => {
      const maxQuery = `
        WITH IndicatorRates AS (SELECT * 
        FROM covid_indicators INNER JOIN census_departments ON covid_indicators.department_number = census_departments.department_number)
        SELECT 
          MAX(hosp / pop) AS hosp,
          MAX(incid_hosp / pop) AS incid_hosp,
          MAX(dchosp / pop) AS dchosp,
          MAX(incid_dchosp / pop) AS incid_dchosp,
          MAX(rea / pop) AS rea,
          MAX(incid_rea / pop) AS incid_rea  
        FROM IndicatorRates
        WHERE LEFT(department_number, 2) != '97'
        ${selectedDepartmentNumber !== "all" ? `AND department_number = '${selectedDepartmentNumber}'` : ""}
      `;

      const maxTable = await duckDBClient.query(maxQuery);
      const maxArray = maxTable.toArray().map((row) => row.toJSON())[0];

      return maxArray;
    },
    { enabled: !!duckDBClient, cacheTime: Infinity, staleTime: Infinity },
  );

  const colorScale = useMemo(() => {
    const domain = [0, maximumIndicators?.[selectedIndicator] * colorSchemeCapping];
    return d3.scaleSequential(colorSchemeOptions[`interpolate${colorScheme}`]).domain(domain);
  }, [maximumIndicators, colorScheme, colorSchemeCapping]);

  useEffect(() => {
    setLoading(isDuckDBTablesLoading);
    setProgress(duckDBProgress * 100);
  }, [duckDBProgress, isDuckDBTablesLoading, setLoading, setProgress]);

  useEffect(() => {
    const fetchData = async (duckDBClient) => {
      const h3Query = `
        WITH SelectedPeriodIndicators AS (
          SELECT 
            AVG(${selectedIndicator})::INT AS indicator,
            FIRST(covid_indicators.department_number) AS department_number,
          FROM covid_indicators
          WHERE 
            strptime(date, '%Y-%m-%d') 
            BETWEEN strptime('${selectedDate.format("YYYY-MM-DD")}', '%Y-%m-%d') 
            AND strptime('${selectedDate.format("YYYY-MM-DD")}', '%Y-%m-%d') + INTERVAL '${timeBucket}' 
          GROUP BY  department_number
          ),
        IndicatorRate AS (
          SELECT
            indicator / census_departments.pop AS indicator_rate,
            census_departments.department_number AS department_number,
            census_departments.pop AS depPop  
          FROM SelectedPeriodIndicators INNER JOIN census_departments ON SelectedPeriodIndicators.department_number = census_departments.department_number 
        ),
        GroupedData AS (
          SELECT 
            h3_cell_to_parent(CONCAT('0x', h3_index)::UBIGINT, ${h3Resolution}) AS h3_index,
            FIRST(department_number) AS department_number,
            SUM(pop) AS pop,
          FROM 
            pop_fr 
          GROUP BY 
            h3_cell_to_parent(CONCAT('0x', h3_index)::UBIGINT, ${h3Resolution})
        )
        SELECT
          h3_cell_to_lat(h3_index) AS latitude,
          h3_cell_to_lng(h3_index) AS longitude,
          h3_index AS h3Index,
          pop::FLOAT AS pop,
          depPop::INT AS depPop,
          indicator_rate AS indicatorRate,
          IndicatorRate.department_number AS departmentNumber
        FROM 
          GroupedData
        INNER JOIN IndicatorRate
        ON GroupedData.department_number = IndicatorRate.department_number
        `;

      const choroplethQuery = `
        SELECT 
          ${selectedIndicator} / census_departments.pop AS indicatorRate,
          census_departments.pop AS depPop,
          census_departments.department_number AS departmentNumber
          FROM covid_indicators INNER JOIN census_departments ON covid_indicators.department_number = census_departments.department_number 
          WHERE strptime(date, '%Y-%m-%d') = strptime('${selectedDate.format("YYYY-MM-DD")}', '%Y-%m-%d')
            AND covid_indicators.department_number = census_departments.department_number
        `;

      const visibleTimelineDuration = visibleTimelineDomain[1].getTime() - visibleTimelineDomain[0].getTime();
      const prefetchedTimelineDomain = [
        visibleTimelineDomain[0].getTime() - visibleTimelineDuration,
        visibleTimelineDomain[1].getTime() + visibleTimelineDuration,
      ].map((d) => new Date(d));

      const timelineQuery = `
        SELECT
          TIME_BUCKET(INTERVAL '${timeBucket}', date::TIMESTAMP) AS start,
          TIME_BUCKET(
              INTERVAL '${timeBucket}',
              TIME_BUCKET(INTERVAL '${timeBucket}', date::TIMESTAMP) + INTERVAL '${timeBucket}'
          ) AS end,
          AVG(${selectedIndicator})::FLOAT AS indicator,
        FROM covid_indicators 
        WHERE
          date::TIMESTAMP BETWEEN '${prefetchedTimelineDomain[0].toISOString()}'::TIMESTAMP AND '${prefetchedTimelineDomain[1].toISOString()}'::TIMESTAMP
          ${selectedDepartmentNumber !== "all" ? `AND department_number = '${selectedDepartmentNumber}'` : ""}
        GROUP BY
          TIME_BUCKET(INTERVAL '${timeBucket}', date::TIMESTAMP)
        ORDER BY
          start;
      `;

      const h3Table = await duckDBClient.query(h3Query);
      const h3TableArray = h3Table.toArray().map((row) => row.toJSON());

      const choroplethTable = await duckDBClient.query(choroplethQuery);
      const choroplethTableArray = choroplethTable.toArray().map((row) => row.toJSON());

      const timelineTable = await duckDBClient.query(timelineQuery);
      const timelineData = timelineTable.toArray().map((row) => row.toJSON());

      await setLoading(true);

      const maxPop = d3.max(h3TableArray, (d) => d.pop);
      const avgCellArea = h3.getHexagonAreaAvg(h3Resolution, h3.UNITS.km2);

      const choroplethFeatures: Feature[] = choroplethTableArray
        .map((row) => {
          if (!row || !departmentsGeoJSON || !departmentsGeoJSON.features) return null;
          const departmentFeature = departmentsGeoJSON.features.find((feature) => feature.properties.code === row.departmentNumber);
          if (!departmentFeature) return null;
          return {
            type: "Feature",
            geometry: departmentFeature.geometry,
            properties: {
              indicatorRate: row.indicatorRate,
              departmentNumber: row.departmentNumber,
              pop: row.pop,
            },
          };
        })
        .filter((d) => d !== null);

      const h3Features: Feature[] = h3TableArray
        .map((row) => {
          // const radiuses = selectedSpecies
          //   .map((species) => toCamelCase(species) + "ReportCount")
          //   .map((key) => {
          //     return Math.sqrt((row[key] * cellWithMaxDensity.cellArea) / cellWithMaxDensity.pop) * 500;
          //   });
          const radius = Math.sqrt((row.pop * avgCellArea) / maxPop) * 500;

          return {
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [row.longitude, row.latitude],
            },
            properties: {
              radius,
              indicatorRate: row.indicatorRate,
              departmentNumber: row.departmentNumber,
              pop: row.pop,
              depPop: row.depPop,
            },
          };
        })
        .flat();

      setLoading(false);
      return { choroplethFeatures, h3Features, timelineData, maxPop };
    };

    if (
      duckDBClient?.query &&
      mapBounds?._sw &&
      mapBounds?._ne &&
      visibleTimelineDomain[0] &&
      visibleTimelineDomain[1] &&
      selectedDate &&
      selectedIndicator &&
      maximumIndicators
    ) {
      fetchData(duckDBClient).then(({ h3Features, choroplethFeatures, timelineData, maxPop }) => {
        setH3Features(h3Features);
        setChoroplethFeatures(choroplethFeatures);
        setTimelineData(timelineData);
        setLoading(false);
        setMaxPop(maxPop);
      });
    }
  }, [
    duckDBClient,
    h3Resolution,
    timelineDomain,
    mapBounds,
    selectedDate,
    visibleTimelineDomain,
    maximumIndicators,
    selectedIndicator,
    selectedDepartmentNumber,
  ]);

  useEffect(() => {
    if (h3Features) {
      setH3Features([...h3Features]);
    }
  }, [radiusScale, strokeWidth]);

  useEffect(() => {
    if (choroplethFeatures) {
      setChoroplethFeatures([...choroplethFeatures]);
    }
  }, [choroplethOpacity, colorScheme, colorSchemeCapping]);

  useEffect(() => {
    if (h3Features) {
      setH3Features([...h3Features]);
    }
  }, [h3Opacity, colorScheme, colorSchemeCapping]);

  const onMapLoad = useCallback(() => {
    if (
      mapRef.current &&
      mapRef.current.fitBounds &&
      mapRef.current.getZoom &&
      mapRef.current.getBounds &&
      mapRef.current.on &&
      mapRef.current.getCenter
    ) {
      const minLatitude = 38;
      const maxLatitude = 52;
      const minLongitude = -5;
      const maxLongitude = 10;

      if (Number.isNaN(minLongitude + minLatitude + maxLongitude + maxLatitude)) return;
      mapRef.current.fitBounds(
        [
          [minLongitude, minLatitude],
          [maxLongitude, maxLatitude],
        ],
        { padding: 50, duration: 1000 },
      );

      mapRef.current.on("zoom", () => {
        if (mapRef.current?.getZoom()) {
          const zoom = mapRef.current.getZoom();
          const latitude = mapRef.current.getCenter().lat;
          const longitude = mapRef.current.getCenter().lng;
          const units = "pixels";
          const newMaxRadiusPixels = getMaxRadius(h3ResolutionRef.current, zoom, latitude, longitude, units);
          debouncedSetMaxRadiusPixels(newMaxRadiusPixels);
        }

        if (mapRef.current?.getZoom()) {
          const newRadiusScale = 1 + Math.round(5 * Math.max(0, 8 - mapRef.current.getZoom())) / 2.5;

          if (newRadiusScale !== radiusScale) setRadiusScale(newRadiusScale);
        }

        if (mapRef.current?.getBounds()) {
          const newMapBounds = mapRef.current?.getBounds();
          if (newMapBounds && newMapBounds !== mapBounds) onMapZoom(newMapBounds);
        }
      });

      mapRef.current.on("move", () => {
        if (mapRef.current?.getBounds()) {
          const newMapBounds = mapRef.current?.getBounds();
          if (newMapBounds && newMapBounds !== mapBounds) onMapZoom(newMapBounds);
        }
      });
    }

    return () => {
      if (mapRef.current && mapRef.current.off) {
        mapRef.current.off("zoom");
        mapRef.current.off("move");
      }
    };
  }, []);

  const onTimelineZoom = useCallback(
    throttle(({ density, visibleDomain }) => {
      setTimeBucket((prevTimeBucket) => {
        const newTimeBucket = calculateTimeBucket(density);
        if (newTimeBucket !== prevTimeBucket) {
          return newTimeBucket;
        } else {
          return prevTimeBucket;
        }
      });
      setVisibleTimelineDomain(visibleDomain);
      brushableTimelineRef.current && brushableTimelineRef.current.setBrushedDomain(visibleDomain);
    }, 100),
    [timeBucket],
  );

  const onTimelineBrush = useCallback(
    throttle(({ brushedDomain }) => {
      setVisibleTimelineDomain(brushedDomain);
      timelineRef.current && timelineRef.current.setVisibleDomain(brushedDomain);
    }, 100),
    [],
  );

  const onTimelineItemClick = useCallback((obj) => {
    setSelectedDate(dayjs(obj.start));
  }, []);

  const onMapZoom = useMemo(
    (newMapBounds) =>
      debounce((newMapBounds) => {
        setMapBounds(newMapBounds);
      }, 50),
    [],
  );

  const mapboxStyle = globalState.theme === "DARK" ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11";

  return (
    <div id="explorer-covid-19">
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
      <div style={{ position: "absolute", top: 60, zIndex: 1, left: 20, width: "max-content", height: "max-content" }}>
        <ColorLegend
          colorScale={colorScale}
          title={`${indicatorMap[selectedIndicator]} per 100,000 inhabitants`}
          tickFormat={(d) => {
            return Math.ceil(d * 100000);
          }}
          tickSize={5}
          width={250}
        />
        <CircleLegend
          circleColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
          textColor={globalState.theme === "DARK" ? "#ffffff" : "#000000"}
          title={"Population density"}
          ticks={5}
          maxValue={maxPop}
          maxRadius={maxRadiusPixels * radiusScale}
          width={275}
        />
        <TimeLegend period={[selectedDate.toDate(), selectedDate.add(1, timeBucket.split(" ")[1]).toDate()]} minDuration={86400000} />
      </div>
      <div className="map-container">
        <ReactMapGL
          initialViewState={INITIAL_FRANCE_MAP_STATE}
          mapboxAccessToken={process.env.MAPBOX_ACCESS_TOKEN}
          mapStyle={mapboxStyle}
          ref={mapRef}
          onLoad={onMapLoad}
        >
          <DeckGLOverlay
            layers={layers}
            interleaved
            getTooltip={({ object: d }) => {
              if (!d) return null;
              return {
                html: `
                  <div><strong>${indicatorMap[selectedIndicator]}</strong>: ${Math.round(d?.properties?.indicatorRate * 100000)} / 100,000 inh.</div>
                  <div><strong>Department</strong>: ${d?.properties?.departmentNumber}</div>
                  <div><strong>Population </strong>: ${d?.properties?.pop}</div>
                  <div><strong>Department population </strong>: ${d?.properties?.depPop}</div>
                  `,
              };
            }}
          />
          <NavigationControl showCompass={false} />
        </ReactMapGL>
        <Button onClick={() => setIsDrawerOpen(true)} style={{ position: "absolute", top: 135, right: 10 }} icon={<SettingOutlined />} />
        <Drawer
          open={isDrawerOpen}
          title={"Parameters"}
          mask={false}
          rootStyle={{
            padding: 10,
            top: 50,
            height: `calc(100vh - 50px - ${timelineHeight}px)`,
          }}
          onClose={() => setIsDrawerOpen(false)}
        >
          <div style={{ marginBottom: 8 }} key="date-selection">
            <DatePickerWithArrows
              onChange={(date) => {
                setSelectedDate(date);
              }}
              period={timeBucket.split(" ")[1]}
              value={selectedDate}
              defaultValue={dayjs("2020-03-20", "YYYY-MM-DD")}
              minDate={dayjs("2020-03-01", "YYYY-MM-DD")}
              maxDate={dayjs("2023-10-31", "YYYY-MM-DD")}
            />
          </div>
          <div style={{ marginBottom: 16 }} key="autoplay">
            <Space>
              <Button style={{ height: 30, marginBottom: 16 }} onClick={handleAutoplayToggle}>
                {autoplay ? "Stop Autoplay" : "Start Autoplay"}
              </Button>
              <Button
                style={{ height: 30, marginBottom: 16 }}
                onClick={() => {
                  setAutoplay(false);
                  setSelectedDate(dayjs("2020-03-20", "YYYY-MM-DD"));
                }}
              >
                Reset
              </Button>
            </Space>
          </div>
          <div style={{ marginBottom: 8 }} key="department-list">
            <Label>Department</Label>
            {departmentList && (
              <Select
                style={{
                  width: 200,
                  marginBottom: 16,
                  marginTop: 8,
                }}
                onChange={(value) => {
                  setSelectedDepartmentNumber(value);
                }}
                options={[
                  { label: "All", value: "all" },
                  ...departmentList.map((d) => ({
                    label: `${d.departmentNumber} - ${d.departmentName}`,
                    value: d.departmentNumber,
                  })),
                ]}
                value={selectedDepartmentNumber}
              />
            )}
          </div>
          <div style={{ marginBottom: 8, marginTop: 8 }} key="indicator-selection">
            <Radio.Group
              onChange={(e) => {
                setSelectedIndicator(e.target.value);
              }}
              value={selectedIndicator}
              style={{ display: "flex", flexDirection: "column", marginBottom: 16 }}
              options={[
                { label: "Hospitalized patients", value: "hosp" },
                { label: "Newly hospitalized patients (24h)", value: "incid_hosp" },
                { label: "Hospital deaths (total)", value: "dchosp" },
                { label: "Hospital deaths (24h)", value: "incid_dchosp" },
                { label: "ICU hospitalization", value: "rea" },
                { label: "Newly ICU hospitalized patients (24h)", value: "incid_rea" },
              ]}
              name="selectedIndicator"
            />
          </div>
          <Label>Dot radius scale</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="dot-radius-scale">
            <Slider min={1} max={10} value={radiusScale} onChange={(value) => setRadiusScale(value)} style={{ width: 200 }} />
          </div>
          <Label>Dot stroke</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="dot-stroke-width">
            <Slider min={240} max={500} value={strokeWidth} onChange={(value) => setStrokeWidth(value)} style={{ width: 200 }} />
          </div>
          <Label>Map type</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="map-type-quick-control">
            <Segmented
              value={mapTypeQuickControl}
              onChange={(value) => {
                setMapTypeQuickControl(value);
                if (value === "choropleth") {
                  setChoroplethOpacity(1.0);
                  setH3Opacity(0.0);
                }
                if (value === "h3") {
                  setChoroplethOpacity(0.0);
                  setH3Opacity(1.0);
                }
              }}
              options={[
                { label: "Choropleth", value: "choropleth" },
                { label: "Population circles", value: "h3" },
              ]}
            />
          </div>
          <Label>Choropleth opacity</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="choropleth-opacity">
            <Slider min={0} max={1} step={0.01} value={choroplethOpacity} onChange={(value) => setChoroplethOpacity(value)} style={{ width: 200 }} />
          </div>
          <Label>Dot opacity</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="dot-opacity">
            <Slider min={0} max={1} step={0.01} value={h3Opacity} onChange={(value) => setH3Opacity(value)} style={{ width: 200 }} />
          </div>
          <Label>Color scheme capping</Label>
          <div style={{ marginBottom: 8, marginTop: 8, display: "flex", justifyContent: "left" }} key="color-scheme-capping">
            <Slider
              min={0.0}
              max={1.0}
              step={0.1}
              value={colorSchemeCapping}
              onChange={(value) => setColorSchemeCapping(value)}
              style={{ width: 200 }}
            />
          </div>
          <div style={{ marginBottom: 8, marginTop: 16 }} key="color-scheme">
            <Label>Color scheme</Label>
            <Select
              style={{
                width: 200,
                marginBottom: 8,
                marginTop: 8,
              }}
              onChange={(value) => {
                setColorScheme(value);
              }}
              value={colorScheme}
              options={[
                {
                  key: "Red",
                  label: colorSchemeLabel("Reds"),
                  value: "Reds",
                },
                {
                  key: "Blues",
                  label: colorSchemeLabel("Blues"),
                  value: "Blues",
                },
                {
                  key: "Greens",
                  label: colorSchemeLabel("Greens"),
                  value: "Greens",
                },
                {
                  key: "Oranges",
                  label: colorSchemeLabel("Oranges"),
                  value: "Oranges",
                },
                {
                  key: "BuRd",
                  label: colorSchemeLabel("BuRd"),
                  value: "BuRd",
                },
                {
                  key: "Plasma",
                  label: colorSchemeLabel("Plasma"),
                  value: "Plasma",
                },
                {
                  key: "Magma",
                  label: colorSchemeLabel("Magma"),
                  value: "Magma",
                },
                {
                  key: "Inferno",
                  label: colorSchemeLabel("Inferno"),
                  value: "Inferno",
                },
              ]}
            />
          </div>
          <Label>H3 resolution</Label>
          <div style={{ marginBottom: 8, marginTop: 8 }} key="h3-resolution">
            <Segmented
              onChange={(value) => {
                setH3Resolution(value);
              }}
              value={h3Resolution}
              options={[
                { label: "Low", value: 5 },
                { label: "Medium", value: 6 },
                { label: "High", value: 7 },
              ]}
            />
          </div>
        </Drawer>
        {timelineDomain && (
          <>
            <ZoomableTimeline
              ref={timelineRef}
              data={timelineData}
              height={120}
              style={{ width: "100%", position: "relative", zIndex: 1001 }}
              domain={timelineDomain}
              visibleDomain={timelineDomain}
              selectedPeriod={[selectedDate.toDate(), selectedDate.add(1, timeBucket.split(" ")[1]).toDate()]}
              onZoom={onTimelineZoom}
              theme={globalState.theme}
              onItemClick={onTimelineItemClick}
            />
            <BrushableTimeline
              ref={brushableTimelineRef}
              data={brushableTimelineData}
              height={40}
              domain={timelineDomain}
              onBrush={onTimelineBrush}
              brushedDomain={timelineDomain}
            />
          </>
        )}
      </div>
    </div>
  );
};
export default ExplorerCovid19;
