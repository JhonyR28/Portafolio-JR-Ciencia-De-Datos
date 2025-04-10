/*******************************************************
  Downscaling diario a partir de ERA5-Land (hora a hora) Google Earth Engine
  con depuraciones adicionales y mensajes de verificación:

  Variables instantáneas (promedio diario):
  - t2m: 2 metre temperature (en Kelvin convertido a °C)            -> Band: "temperature_2m"
  - d2m: 2 metre dewpoint temperature (en Kelvin convertido a °C)       -> Band: "dewpoint_temperature_2m"
  - u10: 10 metre U wind component (m/s)                              -> Band: "u_component_of_wind_10m"
  - v10: 10 metre V wind component (m/s)                              -> Band: "v_component_of_wind_10m"
  - sp:  Surface pressure (Pa)                                         -> Band: "surface_pressure"

  Variables acumulativas (suma diaria):
  - ssr: Surface net short-wave (solar) radiation (J/m²)               -> Band: "surface_net_solar_radiation"
  - str: Surface net long-wave (thermal) radiation (J/m²)              -> Band: "surface_net_thermal_radiation"
  - tp:  Total precipitation (m)                                       -> Band: "total_precipitation"

  Se aplica un modelo de Random Forest para obtener versiones downscaled
  y se corrige el sesgo global. El TIFF final es multibanda, incluyendo las
  variables downscaled_corrected.

  Aún se recomienda una etapa de validación con estaciones meteorológicas cercanas al shapefile "La Libertad" o el elegido
*******************************************************/

// ### 1) Definir la región de interés (ROI)
var roi = ee.FeatureCollection("projects/ee-hipsacsatelital/assets/la_libertad");
Map.centerObject(roi, 9);

// Calcular el área del ROI en km² para muestreo adaptativo
var roiArea = roi.geometry().area().divide(1e6);
print("Área del ROI (km²):", roiArea);

// Visualizar ROI
Map.addLayer(roi, {color: 'blue'}, 'La Libertad');

// ### 2) Cargar DEM y obtener Pendiente y Aspecto
var dem = ee.Image("USGS/SRTMGL1_003").select('elevation');
var terrain = ee.Algorithms.Terrain(dem);
var slope = terrain.select('slope');
var aspect = terrain.select('aspect');

print("DEM:", dem);
print("Slope:", slope);
print("Aspect:", aspect);

// Mapeo entre las variables personalizadas y las bandas reales en ERA5-Land
var bandMapping = {
  't2m': 'temperature_2m',
  'd2m': 'dewpoint_temperature_2m',
  'u10': 'u_component_of_wind_10m',
  'v10': 'v_component_of_wind_10m',
  'sp': 'surface_pressure',
  'ssr': 'surface_net_solar_radiation',
  'str': 'surface_net_thermal_radiation',
  'tp': 'total_precipitation'
};

// ### 3) Función para obtener valores diarios de ERA5-Land para cualquier variable
function getDailyERA5Variable(dateString, varName, isAccumulated) {
  var startDate = ee.Date(dateString);
  var endDate = startDate.advance(1, 'day');
  print("getDailyERA5Variable - Variable:", varName, "startDate:", startDate, "endDate:", endDate);
  
  // Obtener el nombre correcto de la banda según el mapeo
  var eeBand = bandMapping[varName];
  if (!eeBand) {
    print("Error: No se encontró mapeo para la variable", varName);
    return null;
  }
  
  // Cargar la colección horaria
  var collection = ee.ImageCollection("ECMWF/ERA5_LAND/HOURLY")
    .select(eeBand)
    .filterDate(startDate, endDate)
    .filterBounds(roi);
    
  print(eeBand + " count:", collection.size());
  
  // Para variables instantáneas se calcula el promedio; para acumulativas se suma.
  var dailyValue = isAccumulated ? collection.sum() : collection.mean();
  
  // Conversión para variables de temperatura: de Kelvin a Celsius para t2m y d2m
  if (varName === 't2m' || varName === 'd2m') {
    dailyValue = dailyValue.subtract(273.15);
  }
  
  var suffix = isAccumulated ? '_accum' : '_daily';
  return dailyValue.rename(varName + suffix);
}

// ### 4) Variables de ERA5 a procesar con su tipo (acumulativo o instantáneo)
var variables = [
  {name: 't2m', isAccumulated: false},
  {name: 'd2m', isAccumulated: false},
  {name: 'u10', isAccumulated: false},
  {name: 'v10', isAccumulated: false},
  {name: 'sp', isAccumulated: false},
  {name: 'ssr', isAccumulated: true},
  {name: 'str', isAccumulated: true},
  {name: 'tp',  isAccumulated: true}
];

// ### 5) Cargar variables comunes adicionales (NDVI, Land Cover)
// Función modificada para obtener NDVI: si la fecha a procesar está en el mes actual
// (producto potencialmente incompleto) se utiliza el promedio del mes anterior.
function getMonthlyNDVI(date) {
  var day = ee.Date(date);
  // Fecha actual
  var now = ee.Date(Date.now());
  
  // Extraer año y mes para la fecha a procesar y la fecha actual
  var processYear = day.get('year');
  var processMonth = day.get('month');
  var nowYear = now.get('year');
  var nowMonth = now.get('month');
  
  // Evaluar si la fecha a procesar es del mismo mes y año que la fecha actual.
  var condition = ee.Number(processYear).eq(nowYear).and(ee.Number(processMonth).eq(nowMonth));
  // Usar ee.Algorithms.If para evitar error .if no es función de ee.Number
  var ndviDate = ee.Algorithms.If(condition, day.advance(-1, 'month'), day);
  ndviDate = ee.Date(ndviDate);
  
  // Extraer año y mes a partir de ndviDate
  var ndviYear = ndviDate.get('year');
  var ndviMonth = ndviDate.get('month');
  
  // Cargar colección MODIS NDVI 
  var ndviCollection = ee.ImageCollection("MODIS/061/MOD13A1").filterBounds(roi);
  
  // Filtrar para el mes seleccionado y generar un compuesto (mediana)
  var monthlyNDVI = ndviCollection
    .filterDate(
      ee.Date.fromYMD(ndviYear, ndviMonth, 1),
      ee.Date.fromYMD(ndviYear, ndviMonth, 1).advance(1, 'month')
    )
    .select('NDVI')
    .median()
    .multiply(0.0001)
    .rename('NDVI');
  
  print("NDVI usado para fecha:", ndviDate, monthlyNDVI);
  return monthlyNDVI;
}

// Land Cover fijo de 2023 (MCD12Q1)
var lc = ee.ImageCollection("MODIS/061/MCD12Q1")
  .filterBounds(roi)
  .filterDate('2023-01-01', '2023-12-31')
  .first()
  .select('LC_Type1')
  .rename('LandCover');
print("LandCover (2023):", lc);

// ### 6) Función para procesar y aplicar downscaling a una variable individual
function processVariable(dateString, varObj, commonBands, numPoints) {
  var varName = varObj.name;
  var isAccum = varObj.isAccumulated;
  
  // Obtener variable (valor de baja resolución) diaria
  var lowres = getDailyERA5Variable(dateString, varName, isAccum);
  if (!lowres) return null;
  print(varName + " - lowres:", lowres);
  
  // Combinar la variable objetivo con las capas explicativas comunes (NDVI, DEM, slope, aspect, LC)
  var combined = lowres.addBands(commonBands)
    .set('system:time_start', ee.Date(dateString).millis());
  print(varName + " - combined image:", combined);
  
  // Seleccionar la banda objetivo (la primera banda de lowres)
  var target = lowres.bandNames().get(0);
  // Listado de todas las bandas
  var allBands = combined.bandNames();
  // Bandas independientes: todas menos la banda objetivo
  var indepBands = allBands.removeAll([target]);
  print("Todas las bandas para " + varName + ":", allBands);
  print("Bandas independientes para " + varName + ":", indepBands);
  
  // Muestreo adaptativo: utilizar numPoints de puntos de muestreo basado en el ROI
  var trainingPoints = combined.sample({
    region: roi,
    scale: 500,
    numPixels: numPoints,
    seed: 42,
    dropNulls: true
  });
  print("trainingPoints (" + varName + ") feature count:", trainingPoints.size());
  
  // Entrenar el modelo Random Forest
  var model = ee.Classifier.smileRandomForest({
    numberOfTrees: 80,
    seed: 42
  })
  .setOutputMode('REGRESSION')
  .train({
    features: trainingPoints,
    classProperty: target,
    inputProperties: indepBands
  });
  print("Modelo entrenado para " + varName + ":", model);
  
  // Aplicar el modelo para obtener versión high resolution
  var highres = combined.select(indepBands).classify(model).rename('highres');
  print(varName + " - highres:", highres);
  
  // Corrección de sesgo global:
  // Promedio en baja resolución (scale = 9000)
  var meanLow = lowres.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: roi,
    scale: 9000,
    maxPixels: 1e9
  }).getNumber(target);
  print(varName + " - meanLow:", meanLow);
  
  // Promedio en alta resolución (scale = 500)
  var meanHigh = highres.reduceRegion({
    reducer: ee.Reducer.mean(),
    geometry: roi,
    scale: 500,
    maxPixels: 1e9
  }).getNumber('highres');
  print(varName + " - meanHigh:", meanHigh);
  
  // Diferencia para corrección
  var diff = meanLow.subtract(meanHigh);
  print(varName + " - diff (bias):", diff);
  
  // Aplicar la corrección al high resolution
  var corrected = highres.add(diff).rename(varName + "_corrected");
  print(varName + " - corrected:", corrected);
  
  return corrected;
}

// ### 7) Función principal extendida para procesar el día y todas las variables
function processDayExtended(dateString) {
  print("Procesando día extendido:", dateString);
  var day = ee.Date(dateString);
  
  // Obtener NDVI utilizando la función actualizada que ajusta la fecha
  var ndvi = getMonthlyNDVI(dateString);
  
  // Construir imagen con capas comunes: NDVI, DEM, slope, aspect, LC
  var commonBands = ndvi.addBands(dem).addBands(slope).addBands(aspect).addBands(lc);
  print("Capas comunes (NDVI, DEM, slope, aspect, LC):", commonBands);
  
  // Calcular número de puntos de muestreo basado en el ROI (0.5 pts/km², mínimo 1000 y máximo 8000)
  var pointsPerKm2 = 0.5;
  var numPoints = roiArea.multiply(pointsPerKm2).round().int();
  numPoints = numPoints.max(1000).min(8000);
  print("Número óptimo de puntos para muestreo:", numPoints);
  
  // Procesar cada variable y obtener la versión downscaled_corrected
  var correctedList = variables.map(function(v) {
    return processVariable(dateString, v, commonBands, numPoints);
  });
  
  // Combinar todas las bandas correctas en un único TIFF multibanda
  var finalImage = ee.Image.cat(correctedList).set('dayProcessed', dateString);
  print("Imagen final (multibanda) con variables downscaled_corrected:", finalImage);
  return finalImage;
}

// ### 8) Ejecutar el proceso para un día específico y exportar resultado
var dayToProcess = "2025-03-10";
var downscaledDay = processDayExtended(dayToProcess);

if (downscaledDay) {
  // Visualización en el mapa: T2M corrected (500m)
  Map.addLayer(
    downscaledDay.select('t2m_corrected').clip(roi),
    {min: 5, max: 25, palette: ['blue', 'cyan', 'green', 'yellow', 'red']},
    'T2M Corrected (500m) ' + dayToProcess
  );
  
  // Exportar imagen final multibanda en formato TIFF a Google Drive
  Export.image.toDrive({
    image: downscaledDay.clip(roi),
    description: 'ERA5_daily_downscaled_corrected_' + dayToProcess,
    folder: 'ERA5_daily_downscaling',
    region: roi.geometry().bounds(),
    crs: 'EPSG:4326',
    scale: 500,
    maxPixels: 1e13
  });
  
  print('Downscaling diario para', dayToProcess, ': Export completo - TIFF multibanda con variables downscaled_corrected.');
} else {
  print('Error al procesar el día', dayToProcess);
}

// Visualización adicional de cada variable corregida
Map.addLayer(
  downscaledDay.select('d2m_corrected').clip(roi),
  {min: 0, max: 25, palette: ['purple', 'blue', 'green', 'yellow', 'red']},
  'D2M Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('u10_corrected').clip(roi),
  {min: 0, max: 10, palette: ['white', 'blue']},
  'U10 Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('v10_corrected').clip(roi),
  {min: 0, max: 10, palette: ['white', 'blue']},
  'V10 Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('sp_corrected').clip(roi),
  {min: 95000, max: 105000, palette: ['gray', 'yellow', 'red']},
  'SP Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('ssr_corrected').clip(roi),
  {min: 0, max: 200000, palette: ['black', 'orange', 'yellow']},
  'SSR Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('str_corrected').clip(roi),
  {min: 0, max: 150000, palette: ['black', 'blue', 'green']},
  'STR Corrected (500m)'
);

Map.addLayer(
  downscaledDay.select('tp_corrected').clip(roi),
  {min: 0, max: 0.05, palette: ['white', 'blue']},
  'TP Corrected (500m)'
);
