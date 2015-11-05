/**
 * EPSG.io Coordinates JavaScript App
 * ----------------------------------
 * Copyright (C) 2013 - Moravian Library, http://www.mzk.cz/
 * Copyright (C) 2014 - Klokan Technologies GmbH, http://www.klokantech.com/
 * All rights reserved.
 */

goog.provide('epsg.io.Coordinates');

goog.require('goog.Timer');
goog.require('goog.dom');
goog.require('goog.net.Jsonp');
goog.require('kt.Nominatim');
goog.require('ol.Map');
goog.require('ol.View');
goog.require('ol.extent');
goog.require('ol.layer.Tile');
goog.require('ol.source.MapQuest');


/**
 * @type {string}
 * @const
 */
epsg.io.TRANS_SERVICE_URL = '//epsg.io/trans';



/**
 * The main Coordinates object
 * @param {!string} srs Spatial Reference System (usually EPSG code)
 * @param {Array.<number>} bbox [n,w,s,e]
 * @param {number=} opt_lon Longitude of map center (defaults to 0)
 * @param {number=} opt_lat Latitude of map center (defaults to 0)
 * @constructor
 */
epsg.io.Coordinates = function(srs, bbox, opt_lon, opt_lat) {

  // srs
  this.srs_ = srs || '4326';
  // lonlat - longitude and latitude
  this.lon_ = opt_lon || 0;
  this.lat_ = opt_lat || 0;
  // eastnoth
  this.east_ = 0;
  this.north_ = 0;

  // LOAD ALL THE EXPECTED ELEMENTS ON THE PAGE

  this.mapElement = /** @type {!Element} */(goog.dom.getElement('map'));

  this.geocoderElement = /** @type {!HTMLInputElement} */
      (goog.dom.getElement('geocoder'));

  this.latitudeElement = goog.dom.getElement('latitude');
  this.longitudeElement = goog.dom.getElement('longitude');
  this.lonlatFormElement = goog.dom.getElement('lonlat_form');

  this.eastingElement = goog.dom.getElement('easting');
  this.northingElement = goog.dom.getElement('northing');
  this.eastNorthFormElement = goog.dom.getElement('eastnorth_form');
  this.eastNorthCopyElement = goog.dom.getElement('eastnorth_copy');

  this.lonLatMutex = false;

  // Force preservation of user typed values on recalculation
  this.keepLonLat = false;
  this.keepEastNorth = false;

  /**
   * @type {?number}
   * @private
   */
  this.queryTimer_ = null;

  /**
   * @type {!goog.net.Jsonp}
   * @private
   */
  this.jsonp_ = new goog.net.Jsonp(epsg.io.TRANS_SERVICE_URL);

  this.view_ = new ol.View({
    center: ol.proj.fromLonLat([this.lon_, this.lat_]),
    zoom: 8,
    maxZoom: 18
  });

  this.map = new ol.Map({
    target: this.mapElement,
    view: this.view_,
    layers: [
      new ol.layer.Tile({
        source: new ol.source.MapQuest({layer: 'osm'})
      })
    ]
  });

  var size = this.map.getSize();
  if (size) {
    this.view_.fit(
        ol.proj.transformExtent([bbox[1], bbox[2], bbox[3], bbox[0]],
        'EPSG:4326', 'EPSG:3857'), size);
  }

  this.updateLonLat_([this.lon_, this.lat_]);

  this.view_.on('change:center', function(e) {
    var pos = ol.proj.toLonLat(this.view_.getCenter());
    this.updateLonLat_(pos);
  }, this);


  // The user can type latitude / longitude and hit Enter
  goog.events.listen(this.lonlatFormElement, goog.events.EventType.SUBMIT,
      function(e) {
        var latitude = goog.string.toNumber(this.latitudeElement.value);
        var longitude = goog.string.toNumber(this.longitudeElement.value);
        if (!isNaN(latitude) && !isNaN(longitude)) {
          this.keepLonLat = true;
          this.updateLonLat_([longitude, latitude]);
          this.keepLonLat = false;
        }
        e.preventDefault();
      }, false, this);

  // The user can type easting / northing and hit Enter
  goog.events.listen(this.eastNorthFormElement, goog.events.EventType.SUBMIT,
      function(e) {
        var easting = goog.string.toNumber(this.eastingElement.value);
        var northing = goog.string.toNumber(this.northingElement.value);
        if (!isNaN(easting) && !isNaN(northing)) {
          this.east_ = easting;
          this.north_ = northing;
          // Make the query to epsg.io/trans to get new lat/lon
          this.latitudeElement.value = '';
          this.longitudeElement.value = '';
          this.jsonp_.send({
            'x': this.east_,
            'y': this.north_,
            's_srs': this.srs_
          }, goog.bind(function(result) {
            var latitude = goog.string.toNumber(result['y']);
            var longitude = goog.string.toNumber(result['x']);
            this.keepEastNorth = true;
            this.updateLonLat_([longitude, latitude]);
            this.keepEastNorth = false;
          }, this));
        }
        e.preventDefault();
      }, false, this);

  if (this.geocoderElement) {
    var nominatim = new kt.Nominatim(this.geocoderElement,
        'http://nominatim.klokantech.com/');
    nominatim.registerCallback(goog.bind(function(bnds) {
      this.geocoderElement.value = '';
      var size = this.map.getSize();
      if (size && ol.extent.getArea(bnds) > 1e-5) {
        this.view_.fit(
            ol.proj.transformExtent(bnds, 'EPSG:4326', 'EPSG:3857'), size);
      } else {
        this.view_.setCenter(ol.proj.fromLonLat(ol.extent.getCenter(bnds)));
        this.view_.setZoom(15);
      }
    }, this));
  }


  // ZeroClipboard initialization
  var ZeroClipboard = window['ZeroClipboard'];
  ZeroClipboard['config']({ 'moviePath': '/js/ZeroClipboard.swf' });
  this.eastNorthZeroClipboard = new ZeroClipboard(this.eastNorthCopyElement);

  this.eastNorthZeroClipboard['on']('dataRequested',
      goog.bind(function(client, args) {
        var eastNorthText = this.eastingElement.value + '\t' +
            this.northingElement.value;
        client['setText'](eastNorthText);
      }, this));

};


/**
 * The throttled call for the coordinates transformation via JSONP
 * @protected
 */
epsg.io.Coordinates.prototype.makeQuery = function() {

  this.eastingElement.value = '';
  this.northingElement.value = '';

  // If the timer has a waiting query, then trash it -
  // it is obsolete, because we have a new one
  if (this.queryTimer_) {
    goog.Timer.clear(this.queryTimer_);
    this.queryTimer_ = null;
  }

  // Don't proceed with the JSONP query immediatelly,
  //   but wait for 500 ms if the user doesn't make a new one.
  this.queryTimer_ = goog.Timer.callOnce(function() {
    var data = { 'x': this.lon_, 'y': this.lat_, 't_srs': this.srs_ };
    if (this.srs_ == '4326') {// no need to transform
      this.showResult(data);
    } else {
      this.jsonp_.send(data, goog.bind(this.showResult, this));
    }
  }, 500, this);
};


/**
 * @param {ol.Coordinate} lonlat
 * @private
 */
epsg.io.Coordinates.prototype.updateLonLat_ = function(lonlat) {
  if (this.lonLatMutex) return;
  this.lonLatMutex = true;
  this.lat_ = lonlat[1];
  this.lon_ = lonlat[0];
  if (!this.keepLonLat) {
    this.latitudeElement.value = this.lat_;
    this.longitudeElement.value = this.lon_;
  }
  if (!this.keepEastNorth) {
    this.makeQuery();
  }
  this.view_.setCenter(ol.proj.fromLonLat([this.lon_, this.lat_]));
  this.lonLatMutex = false;
};


/**
 * Display results
 * @param {Object} result
 */
epsg.io.Coordinates.prototype.showResult = function(result) {

  if (!this.keepEastNorth) {
    // SHOW THE RESULT
    this.eastingElement.value = result.x;
    this.northingElement.value = result.y;
  }

  // Stop the timer
  this.queryTimer_ = null;
};
