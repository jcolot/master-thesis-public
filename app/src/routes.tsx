import { CompassOutlined } from "@ant-design/icons";
import { Result, Spin } from "antd";
import React from "react";
import { useRouteError } from "react-router-dom";
import AppLayout from "./components/AppLayout/AppLayout";
import HomeButton from "./components/UI/HomeButton";
import RetryButton from "./components/UI/RetryButton";
import ExplorerMosquitoAlert from "./components/ExplorerMosquitoAlert/ExplorerMosquitoAlert";
import About from "./components/About/About";
import ExplorerCovid19 from "./components/ExplorerCovid19/ExplorerCovid19";

const LoadingSpin = () => <Spin spinning={true} tip="Loading..." style={{ textAlign: "center", width: "100%", marginTop: "50px" }} />;

export const NotFound = () => <Result status="404" title="404" subTitle="Sorry, the page you visited does not exist." extra={<HomeButton />} />;
export const ErrorBoundary = () => {
  const error = useRouteError();
  return <Result status="500" title={error.toString()} subTitle="Sorry, something went wrong" extra={<RetryButton />} />;
};

export const routes = [
  {
    path: "/",
    key: "root",
    id: "root",
    element: <AppLayout />,
    errorElement: <ErrorBoundary />,
    children: [
      {
        id: "about",
        key: "about",
        path: "/",
        element: <About />,
        title: "About this project",
        icon: CompassOutlined,
      },
      {
        id: "events",
        key: "events",
        path: "mosquito-alert/",
        element: <ExplorerMosquitoAlert />,
        title: "MosquitoAlert reports",
        icon: CompassOutlined,
      },
      {
        id: "covid19",
        key: "covid19",
        path: "covid-19/",
        element: <ExplorerCovid19 />,
        title: "COVID-19 France",
        icon: CompassOutlined,
      },
      {
        id: "not-found",
        key: "not-found",
        path: "*",
        element: <NotFound />,
      },
    ],
  },
];

const appendChildren = (routes) => [].concat(...routes.map((route) => (route.children ? appendChildren(route.children) : route)));

export const menuRoutes = appendChildren(routes)
  .filter((route) => !!route.title)
  .map((route) => ({
    id: route.id,
    path: route.path,
    title: route.title,
    icon: route.icon,
  }));
