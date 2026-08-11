model LinearThermalRamp
  "Minimal balanced solver-conformance model; not a physical thermal oracle."
  parameter Real initialTemperature(unit = "degC") = 20;
  parameter Real heatingRate(unit = "K/s") = 1;
  output Real temperatureC(
    unit = "degC",
    start = initialTemperature,
    fixed = true);
equation
  der(temperatureC) = heatingRate;
end LinearThermalRamp;
