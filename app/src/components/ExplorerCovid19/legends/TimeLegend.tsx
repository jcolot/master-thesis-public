const TimeLegend = ({ period, minDuration }) => {
  let formattedPeriod = period
    .map((p) => {
      return p.toISOString().split("T")[0];
    })
    .join(" - ");

  if (period[1].getTime() - period[0].getTime() <= minDuration) {
    formattedPeriod = period[0].toISOString().split("T")[0];
  }

  return (
    <>
      <div style={{ fontWeight: "bold", fontSize: 10, marginBottom: 8 }}>Time Period</div>
      <span style={{ fontSize: 10 }}>{formattedPeriod}</span>
    </>
  );
};

export default TimeLegend;
