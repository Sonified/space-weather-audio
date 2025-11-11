// Station configuration data (active stations within 20km of top 5 volcanoes)
export const EMBEDDED_STATIONS = {
  "greatsitkin": {
    "name": "Great Sitkin",
    "lat": 52.0765,
    "lon": -176.1109,
    "seismic": [
      {
        "network": "AV",
        "station": "GSTD",
        "location": "",
        "channel": "BHZ",
        "distance_km": 3.3,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "GSTR",
        "location": "",
        "channel": "BHZ",
        "distance_km": 4.1,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "GSSP",
        "location": "",
        "channel": "BHZ",
        "distance_km": 4.9,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "GSMY",
        "location": "",
        "channel": "BHZ",
        "distance_km": 5.2,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "GSCK",
        "location": "",
        "channel": "BHZ",
        "distance_km": 7.7,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "GSIG",
        "location": "",
        "channel": "BHZ",
        "distance_km": 16.2,
        "sample_rate": 50,
        "priority": 0
      }
    ],
    "infrasound": [
      {
        "network": "AV",
        "station": "GSMY",
        "location": "",
        "channel": "BDF",
        "distance_km": 5.2,
        "sample_rate": 50
      }
    ]
  },
  "shishaldin": {
    "name": "Shishaldin",
    "lat": 54.7554,
    "lon": -163.9711,
    "seismic": [
      {
        "network": "AV",
        "station": "SSLS",
        "location": "",
        "channel": "BHZ",
        "distance_km": 5.4,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SSLN",
        "location": "",
        "channel": "BHZ",
        "distance_km": 6.5,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SSBA",
        "location": "",
        "channel": "BHZ",
        "distance_km": 10.1,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "ISNN",
        "location": "",
        "channel": "BHZ",
        "distance_km": 14.9,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "ISLZ",
        "location": "",
        "channel": "BHZ",
        "distance_km": 16.9,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "BRPK",
        "location": "",
        "channel": "BHZ",
        "distance_km": 19.2,
        "sample_rate": 50,
        "priority": 0
      }
    ],
    "infrasound": [
      {
        "network": "AV",
        "station": "SSLS",
        "location": "",
        "channel": "BDF",
        "distance_km": 5.4,
        "sample_rate": 50
      },
      {
        "network": "AV",
        "station": "SSLN",
        "location": "",
        "channel": "BDF",
        "distance_km": 6.5,
        "sample_rate": 50
      },
      {
        "network": "AV",
        "station": "SSBA",
        "location": "",
        "channel": "BDF",
        "distance_km": 10.1,
        "sample_rate": 50
      }
    ]
  },
  "spurr": {
    "name": "Spurr",
    "lat": 61.2989,
    "lon": -152.2539,
    "seismic": [
      {
        "network": "AV",
        "station": "SPCP",
        "location": "",
        "channel": "BHZ",
        "distance_km": 6.4,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPBG",
        "location": "",
        "channel": "BHZ",
        "distance_km": 7.7,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPCN",
        "location": "",
        "channel": "BHZ",
        "distance_km": 9.2,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "N20K",
        "location": "",
        "channel": "BHZ",
        "distance_km": 11.2,
        "sample_rate": 40,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPCG",
        "location": "",
        "channel": "BHZ",
        "distance_km": 12.4,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPCL",
        "location": "",
        "channel": "BHZ",
        "distance_km": 12.4,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPWE",
        "location": "",
        "channel": "BHZ",
        "distance_km": 16.5,
        "sample_rate": 50,
        "priority": 0
      },
      {
        "network": "AV",
        "station": "SPU",
        "location": "",
        "channel": "BHZ",
        "distance_km": 16.8,
        "sample_rate": 50,
        "priority": 0
      }
    ],
    "infrasound": [
      {
        "network": "AV",
        "station": "SPCP",
        "location": "",
        "channel": "BDF",
        "distance_km": 6.4,
        "sample_rate": 50
      },
      {
        "network": "AV",
        "station": "N20K",
        "location": "20",
        "channel": "BDF",
        "distance_km": 11.2,
        "sample_rate": 20
      },
      {
        "network": "AV",
        "station": "N20K",
        "location": "EP",
        "channel": "BDF",
        "distance_km": 11.2,
        "sample_rate": 40
      },
      {
        "network": "AV",
        "station": "N20K",
        "location": "EP",
        "channel": "BDO",
        "distance_km": 11.2,
        "sample_rate": 40
      },
      {
        "network": "AV",
        "station": "SPWE",
        "location": "",
        "channel": "BDF",
        "distance_km": 16.5,
        "sample_rate": 50
      },
      {
        "network": "AV",
        "station": "SPU",
        "location": "",
        "channel": "BDF",
        "distance_km": 16.8,
        "sample_rate": 50
      }
    ]
  },
  "kilauea": {
    "name": "Kilauea",
    "lat": 19.421,
    "lon": -155.287,
    "seismic": [
      {
        "network": "HV",
        "station": "UWE",
        "location": "",
        "channel": "HHZ",
        "distance_km": 0.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "UWE",
        "location": "QC",
        "channel": "EHZ",
        "distance_km": 0.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "UWE",
        "location": "QC",
        "channel": "HHZ",
        "distance_km": 0.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "OBL",
        "location": "",
        "channel": "HHZ",
        "distance_km": 0.5,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "UWB",
        "location": "",
        "channel": "HHZ",
        "distance_km": 1.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "SBL",
        "location": "",
        "channel": "HHZ",
        "distance_km": 2.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "WRM",
        "location": "",
        "channel": "HHZ",
        "distance_km": 2.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "HAT",
        "location": "",
        "channel": "HHZ",
        "distance_km": 2.7,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "BYL",
        "location": "",
        "channel": "HHZ",
        "distance_km": 3,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "RIMD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 3.2,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "KKO",
        "location": "",
        "channel": "HHZ",
        "distance_km": 3.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "SDH",
        "location": "",
        "channel": "HHZ",
        "distance_km": 3.5,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "OTLD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 3.9,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "RSDD",
        "location": "01",
        "channel": "HHZ",
        "distance_km": 4.5,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "CPKD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 5.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "NAHU",
        "location": "",
        "channel": "HHZ",
        "distance_km": 5.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "PUHI",
        "location": "",
        "channel": "HHZ",
        "distance_km": 5.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "PUHI",
        "location": "00",
        "channel": "HHZ",
        "distance_km": 5.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "AHUD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 6,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "AHUD",
        "location": "00",
        "channel": "HHZ",
        "distance_km": 6,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "KOSM",
        "location": "",
        "channel": "HHZ",
        "distance_km": 7.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "DEVL",
        "location": "",
        "channel": "HHZ",
        "distance_km": 7.2,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "PAUD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 9.2,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "MITD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 9.6,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "MLOD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 13.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "KNHD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 13.2,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "HLPD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 14,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "DESD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 14.2,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "POLD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 16.9,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "STCD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 17.4,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "AIND",
        "location": "",
        "channel": "HHZ",
        "distance_km": 18.7,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "NPOC",
        "location": "",
        "channel": "HHZ",
        "distance_km": 18.9,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "JCUZ",
        "location": "",
        "channel": "HHZ",
        "distance_km": 19.9,
        "sample_rate": 100,
        "priority": 0
      }
    ],
    "infrasound": [
      {
        "network": "UH",
        "station": "MENE2",
        "location": "01",
        "channel": "BDF",
        "distance_km": 7,
        "sample_rate": 40
      },
      {
        "network": "UH",
        "station": "MENE4",
        "location": "01",
        "channel": "BDF",
        "distance_km": 7,
        "sample_rate": 40
      },
      {
        "network": "UH",
        "station": "MENE1",
        "location": "01",
        "channel": "BDF",
        "distance_km": 7.1,
        "sample_rate": 40
      },
      {
        "network": "UH",
        "station": "MENE3",
        "location": "01",
        "channel": "BDF",
        "distance_km": 7.1,
        "sample_rate": 40
      },
      {
        "network": "UH",
        "station": "MENE5",
        "location": "01",
        "channel": "BDF",
        "distance_km": 7.1,
        "sample_rate": 40
      }
    ]
  },
  "maunaloa": {
    "name": "Mauna Loa",
    "lat": 19.475,
    "lon": -155.608,
    "seismic": [
      {
        "network": "HV",
        "station": "MOKD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 1.6,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "SWRD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 2.6,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "WILD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 3,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "ALEP",
        "location": "",
        "channel": "EHZ",
        "distance_km": 8.3,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "RCOD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 8.3,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "ELEP",
        "location": "",
        "channel": "EHZ",
        "distance_km": 9.1,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "TRAD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 9.5,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "TOUO",
        "location": "",
        "channel": "HHZ",
        "distance_km": 10.5,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "DAND",
        "location": "",
        "channel": "EHZ",
        "distance_km": 14.7,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "PLAD",
        "location": "",
        "channel": "EHZ",
        "distance_km": 17,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "HSSD",
        "location": "",
        "channel": "HHZ",
        "distance_km": 19.3,
        "sample_rate": 100,
        "priority": 0
      },
      {
        "network": "HV",
        "station": "AIND",
        "location": "",
        "channel": "HHZ",
        "distance_km": 19.5,
        "sample_rate": 100,
        "priority": 0
      }
    ],
    "infrasound": []
  }
};