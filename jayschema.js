//
// JaySchema (draft v4) validator for Node.js.
//

'use strict';

var jsonPointer = require('./jsonPointer.js')
  , url = require('url')
  , Errors = require('./errors.js')
  , uuid = require('./uuid.js')
  ;


var DEFAULT_SCHEMA_VERSION = 'http://json-schema.org/draft-04/schema#';
var ANON_URI_SCHEME = 'anon-schema';

var schemaTestSets = {
  'http://json-schema.org/draft-04/schema#': require('./suites/draft-04.js')
};

// ******************************************************************
// Constructor
// ******************************************************************
var JaySchema = function() {
  // internal
  this.schemas = {};
  this._urlsRequested = [];
  this._missingSchemas = {};
};

// ******************************************************************
// Get an array of $refs for which we don’t have a schema yet.
// ******************************************************************
JaySchema.prototype.getMissingSchemas = function() {
  return Object.keys(this._missingSchemas);
};

// ******************************************************************
// Register the given schema in our library of schemas. Returns a
// list of $ref-erenced schemas which are not currently registered.
// ******************************************************************
JaySchema.prototype.register = function(schema, id, _resolutionScope, _path) {
  var index, len, baseUri;

  if (typeof schema !== 'object' || Array.isArray(schema)) { return []; }

  // We stash each schema that has a unique URI, not including
  // the fragment part.

  id = schema.id || id;
  _resolutionScope = _resolutionScope || id;

  if (id) {

    // Only schemas with an id are stashed. Without an id there’d be
    // no way to reference it from another schema.

    var resolvedId = jsonPointer.resolve(_resolutionScope, id);
    _resolutionScope = resolvedId;

    var parts = url.parse(resolvedId);
    var isFragment = !(!parts.hash || parts.hash === '#' || parts.hash === '');
    baseUri = JaySchema._getBaseUri(resolvedId);

    if (isFragment) {
      // fragment of a top-level schema
      if (this.schemas.hasOwnProperty(baseUri)) {
        if (!this.schemas[baseUri].fragments.hasOwnProperty(parts.hash)) {
          this.schemas[baseUri].fragments[parts.hash] = _path;
        }
      }
    } else {
      // top-level schema
      if (!this.schemas.hasOwnProperty(baseUri)) {
        this.schemas[baseUri] = { schema: schema, fragments: {} };
        _path = '#';
        if (baseUri in this._missingSchemas) {
          delete this._missingSchemas[baseUri];
        }
      }
    }

  }

  var refs = [];
  if (schema.hasOwnProperty('$ref')) { refs.push(schema.$ref); }

  // register sub-schemas
  var keys = Object.keys(schema);
  for (index = 0, len = keys.length; index !== len; ++index) {
    var key = keys[index];
    if (typeof schema[key] === 'object') {
      if (Array.isArray(schema[key])) {
        for (var y = 0, yLen = schema[key].length; y !== yLen; ++y) {
          refs = refs.concat(this.register(schema[key][y], null,
            _resolutionScope, _path + '/' + key + '/' + y));
        }
      } else {
        refs = refs.concat(this.register(schema[key], null, _resolutionScope,
          _path + '/' + key));
      }
    }
  }

  // determine which refs are missing
  var missing = {};
  for (index = 0, len = refs.length; index !== len; ++index) {
    var ref = refs[index];
    if (ref[0] !== '#') {
      baseUri = JaySchema._getBaseUri(ref);
      if (!this.schemas.hasOwnProperty(baseUri)) {
        missing[baseUri] = true;
        this._missingSchemas[baseUri] = true;
      }
    }
  }

  return Object.keys(missing);
};

// ******************************************************************
// [static] Given a schema’s id, returns the base URI name, removing
// any fragment sections.
// ******************************************************************
JaySchema._getBaseUri = function(id) {
  var parts = url.parse(id);
  delete parts.hash;
  return url.format(parts);
};

// ******************************************************************
// Get a previously-registered schema, if available. Returns null if
// the schema is not available.
// ******************************************************************
JaySchema.prototype.getSchema = function(resolvedId) {
  var parts = url.parse(resolvedId);
  var fragment = parts.hash;
  delete parts.hash;
  var baseUri = url.format(parts);

  if (!this.schemas.hasOwnProperty(baseUri)) { return null; }

  if (!fragment || fragment === '#' || fragment === '') {

    // base, non-fragment URI
    return this.schemas[baseUri].schema;
  } else {

    // It’s a fragment, and can be either a JSON pointer or a URI
    // fragment identifier. In the latter case, look up the
    // corresponding JSON pointer and proceed.

    if (fragment.slice(0, 2) !== '#/') {  // URI fragment
      fragment = this.schemas[baseUri].fragments[fragment] || fragment;
    }

    var path = fragment.slice(2).split('/');
    var currentSchema = this.schemas[baseUri].schema;
    while (path.length) {
      var element = jsonPointer.decode(path.shift());
      if (!currentSchema.hasOwnProperty(element)) { return null; }
      currentSchema = currentSchema[element];
    }
    return currentSchema;
  }
};

// ******************************************************************
// [static] Helper to gather all $refs values from the given object
// ******************************************************************
JaySchema._gatherRefs = function(obj) {
  var result = [];

  var currentObj = obj;
  var subObjects = [];

  do {

    if (currentObj.hasOwnProperty('$ref')) { result.push(currentObj.$ref); }

    var keys = Object.keys(currentObj);
    for (var index = 0, len = keys.length; index !== len; ++index) {
      var prop = currentObj[keys[index]];
      if (typeof prop === 'object') { subObjects.push(prop); }
    }

    currentObj = subObjects.pop();

  } while(currentObj);

  return result;
};

// ******************************************************************
// The main validation guts (internal implementation).
// ******************************************************************
JaySchema.prototype._validateImpl = function(instance, schema, resolutionScope,
  instanceContext)
{
  // for schemas that have no id, use an internal anonymous id
  var schemaId = schema.id || ANON_URI_SCHEME + '://' + uuid.uuid4() + '#';
  this.register(schema, schemaId, resolutionScope);
  resolutionScope = resolutionScope || schemaId;

  // dereference schema if needed
  if (schema.hasOwnProperty('$ref')) {
    var ref = jsonPointer.resolve(resolutionScope, decodeURI(schema.$ref));
    resolutionScope = ref;
    schema = this.getSchema(ref);

    if (!schema) {
      var desc = 'schema not available: ' + ref;
      if (ref.slice(0, 4) === 'http') {
        desc += ' [on-demand loading of schemas is not supported at the ' +
          'moment; support will return soon using an improved mechanism]';
      }
      var err = new Errors.ValidationError(null, null, null, null, null,
        desc);
      return [err];
    }
  }

  // no schema passed
  if (!schema) { return [];}

  // create the TestSet for this schema version
  var TestSetClass = schemaTestSets[schema.$schema || DEFAULT_SCHEMA_VERSION];
  var testSet = new TestSetClass(this._validateImpl.bind(this), instance,
    schema, resolutionScope, instanceContext || '#');

  return testSet.run();
};

// ******************************************************************
// The main validation function (public API). Our raison d'être.
// ******************************************************************
JaySchema.prototype.validate = function(instance, schema, callback)
{
  // for schemas that have no id, use an internal anonymous id
  var schemaId = schema.id || ANON_URI_SCHEME + '://' + uuid.uuid4() + '#';
  this.register(schema, schemaId);

  if (callback) {
    var result = this._validateImpl(instance, schema);
    if (result.length) { process.nextTick(callback.bind(null, result)); }
    else { process.nextTick(callback); }
  } else {
    return this._validateImpl(instance, schema);
  }
};

module.exports = JaySchema;
