module.exports = function () {
  return {
    devServer: {
      client: {
        overlay: {
          errors: true,
          warnings: false,
          runtimeErrors: (runtimeError) => {
            if (runtimeError.message.includes("ResizeObserver")) {
              return false;
            }
            return true;
          },
        },
      },
    },
    plugin: {
      overrideWebpackConfig: ({ webpackConfig }) => {
        webpackConfig.experiments = { asyncWebAssembly: true };

        // The last rule in the react-scripts webpack.config.js is a
        // file-loader which loads any asset not caught by previous rules. We
        // need to exclude `.wasm` files so that they are instead loaded by
        // webpacks internal webassembly loader (which I believe is enabled by
        // the experiment setting above).
        //
        // See https://github.com/facebook/create-react-app/blob/d960b9e38c062584ff6cfb1a70e1512509a966e7/packages/react-scripts/config/webpack.config.js#L587
        webpackConfig.module.rules
          .at(-1)
          .oneOf.at(-1)
          .exclude.push(/\.wasm$/);
        return webpackConfig;
      },
    },
  };
};
