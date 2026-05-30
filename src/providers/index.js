'use strict';

const { searchHDHub4u, findDirectPage } = require('./hdhub4u');
const { search4KHDHub4u } = require('./4khdhub');
const { searchExtraFlix } = require('./extraflix');
const { searchUHDRodeo, getUHDRodeoLinks } = require('./uhdrodeo');
const { searchMoviesDrives, getMoviesDrivesLinks } = require('./moviesdrives');
const { searchMWSDb, getMWSDbStreams } = require('./mwsdb');
const { getDownloadLinks } = require('./downloadLinks');

module.exports = {
  searchHDHub4u,
  findDirectPage,
  search4KHDHub4u,
  searchExtraFlix,
  searchUHDRodeo,
  getUHDRodeoLinks,
  searchMoviesDrives,
  getMoviesDrivesLinks,
  searchMWSDb,
  getMWSDbStreams,
  getDownloadLinks
};
