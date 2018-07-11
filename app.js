/**
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License'); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */
'use strict';

require('dotenv').config({
    silent: true
});
const express = require('express'); // app server
const bodyParser = require('body-parser'); // parser for post requests
const watson = require('watson-developer-cloud'); // watson sdk
const fs = require('fs'); // file system for loading JSON
const parseJson = require('parse-json');
const Twitter = require('twitter');
var uuid = require('uuid');

var basicAuth = require('basic-auth-connect');


const request = require("request");

const numeral = require('numeral');
const vcapServices = require('vcap_services');
const bankingServices = require('./banking_services');
const WatsonDiscoverySetup = require('./lib/watson-discovery-setup');
const WatsonConversationSetup = require('./lib/watson-conversation-setup');

const DEFAULT_NAME = 'watson-banking-chatbot';
const DISCOVERY_ACTION = 'rnr'; // Replaced RnR w/ Discovery but Conversation action is still 'rnr'.
const DISCOVERY_DOCS = [
    './data/discovery/docs/BarwabankFAQ.docx',
    './data/discovery/docs/Arabicbarwabank.docx'

];

const LOOKUP_BALANCE = 'balance';
const LOOKUP_twitter = 'twitter';
const LOOKUP_TRANSACTIONS = 'transactions';
const LOOKUP_5TRANSACTIONS = '5transactions';


var cloudantCredentials = vcapServices.getCredentials('cloudantNoSQLDB');
var cloudantUrl = null;
if (cloudantCredentials) {
  cloudantUrl = cloudantCredentials.url;
}
cloudantUrl = cloudantUrl || process.env.CLOUDANT_URL; // || '<cloudant_url>';
var logs = null;


const app = express();

// Bootstrap application settings
app.use(express.static('./public')); // load UI from public folder
app.use(bodyParser.json());
require('cf-deployment-tracker-client').track();
require('metrics-tracker-client').track();

// setupError will be set to an error message if we cannot recover from service setup or init error.
let setupError = '';

// Credentials for services
const conversationCredentials = vcapServices.getCredentials('conversation');
const nluCredentials = vcapServices.getCredentials('natural-language-understanding');
const toneAnalyzerCredentials = vcapServices.getCredentials('tone_analyzer');
const discoveryCredentials = vcapServices.getCredentials('discovery');


var client = new Twitter({
    consumer_key: 'rnWZji9ndPxDci4tynbo0DBfG',
    consumer_secret: 'FGcBgdH1DXeiv561b1yLuPCb1Mvk8XA97g9sXO3T2mYxnPQKRV',
    access_token_key: '319242598-FeckTHLmSWS1BApGliQzGuTGk1DB70K5Q0EMYxYF',
    access_token_secret: '5oMdLpbPaNgf3SkYCyNdJH0bxpmLiGR1Qy8MBH6NtunOB'
});


var PersonalityInsightsV3 = require('watson-developer-cloud/personality-insights/v3');
var personality_insights = new PersonalityInsightsV3({
    username: '2c677739-1f34-4775-b033-f5dce6c6c3d6',
    password: 'VNkzDVgIYcPv',
    version_date: '2017-10-13'
});



var DiscoveryV1 = require('watson-developer-cloud/discovery/v1');

var discovery = new DiscoveryV1({
  password: discoveryCredentials.password,
  username: discoveryCredentials.username,
  version_date: '2017-10-16',
  version: 'v1'
  });

// const discovery = watson.discovery({
//     password: discoveryCredentials.password,
//     username: discoveryCredentials.username,
//     version_date: '2017-10-16',
//     version: 'v1'
// });
let discoveryParams; // discoveryParams will be set after Discovery is validated and setup.
const discoverySetup = new WatsonDiscoverySetup(discovery);
const discoverySetupParams = {
    default_name: DEFAULT_NAME,
    documents: DISCOVERY_DOCS
};
discoverySetup.setupDiscovery(discoverySetupParams, (err, data) => {
    if (err) {
        handleSetupError(err);
    } else {
        console.log('Discovery is ready!');
        discoveryParams = data;
    }
});

// Create the service wrapper
const conversation = watson.conversation({
    url: conversationCredentials.url,
    username: conversationCredentials.username,
    password: conversationCredentials.password,
    version_date: '2016-07-11',
    version: 'v1'
});

let workspaceID; // workspaceID will be set when the workspace is created or validated.
const conversationSetup = new WatsonConversationSetup(conversation);
const workspaceJson = JSON.parse(fs.readFileSync('data/conversation/workspaces/banking bot.json'));
const conversationSetupParams = {
    default_name: DEFAULT_NAME,
    workspace_json: workspaceJson
};
conversationSetup.setupConversationWorkspace(conversationSetupParams, (err, data) => {
    if (err) {
        handleSetupError(err);
    } else {
        console.log('Conversation is ready!');
        workspaceID = data;
    }
});

const toneAnalyzer = watson.tone_analyzer({
    username: toneAnalyzerCredentials.username,
    password: toneAnalyzerCredentials.password,
    url: toneAnalyzerCredentials.url,
    version: 'v3',
    version_date: '2016-05-19'
});

/* ******** NLU ************ */
const NaturalLanguageUnderstandingV1 = require('watson-developer-cloud/natural-language-understanding/v1.js');
const nlu = new NaturalLanguageUnderstandingV1({
    username: nluCredentials.username,
    password: nluCredentials.password,
    version_date: '2017-02-27'
});

// Endpoint to be called from the client side
app.post('/api/message', function(req, res) {
    if (setupError) {
        return res.json({
            output: {
                text: 'The app failed to initialize properly. Setup and restart needed.' + setupError
            }
        });
    }

    if (!workspaceID) {
        return res.json({
            output: {
                text: 'Conversation initialization in progress. Please try again.'
            }
        });
    }

    bankingServices.getPerson(7829706, function(err, person) {
        if (err) {
            console.log('Error occurred while getting person data ::', err);
            return res.status(err.code || 500).json(err);
        }

        const payload = {
            workspace_id: workspaceID,
            // context: {
            //     person: person
            // },
            context: req.body.context || {},
            input: {}
        };

        // common regex patterns
        const regpan = /^([a-zA-Z]){5}([0-9]){4}([a-zA-Z]){1}?$/;
        // const regadhaar = /^\d{12}$/;
        // const regmobile = /^(?:(?:\+|0{0,2})91(\s*[\-]\s*)?|[0]?)?[789]\d{9}$/;
        if (req.body) {
            if (req.body.input) {
                let inputstring = req.body.input.text;
                //  console.log('input string ', inputstring);
                const words = inputstring.split(' ');
                //  console.log('words ', words);

                inputstring = '';
                for (let i = 0; i < words.length; i++) {
                    if (regpan.test(words[i]) === true) {
                        // const value = words[i];
                        words[i] = '1111111111';
                    }
                    inputstring += words[i] + ' ';
                }
                // words.join(' ');
                inputstring = inputstring.trim();
                //  console.log('After inputstring ', inputstring);
                // payload.input = req.body.input;
                payload.input.text = inputstring;
            }
            if (req.body.context) {
                // The client must maintain context/state
                payload.context = req.body.context;
            }
        }
        // const queryInput = JSON.stringify(payload.input);
        // // const context_input = JSON.stringify(payload.context);
        //
        // if (queryInput == '{"text":"arabic"}') {
        //     workspaceID = '8a9ef81e-bd71-47fb-a83d-2da798842192';
        // }

        callconversation(payload);
    });

    /**
     * Send the input to the conversation service.
     * @param payload
     */
    function callconversation(payload) {
        // workspaceID = 'a72b3394-1fb1-43b2-9c34-7aad80bc754c';
      var queryInput = JSON.stringify(payload.input);
      // const context_input = JSON.stringify(payload.context);

      var str2 = queryInput;

      console.log("HANDLER DETECTED", str2.includes(''));





     if (queryInput == '{"text":"Arabic"}') {
          workspaceID = 'd2c6c5eb-96b5-40b8-884c-ffc582faf091';
      }
      else if (queryInput == '{"text":"English"}') {
           workspaceID = 'd6a4f221-b053-4f40-bc3d-a35dfec8ac45';
       }

      console.log("init")
      var id = null;

        if (payload.input.text != '') {
          if (logs) {
                // If the logs db is set, then we want to record all input and responses
                console.log("Inside Log function")
                id = uuid.v4();
              //  logs.insert({'_id': id, 'request': payload.input.text, 'time': new Date()});



  //               logs.find(payload.input.text == "sup", function(err, data) {
  //   // The rest of your code goes here. For example:
  //   console.log("Found dog:", id);
  // });

  // logs.get("sup", function(err, data) {
  //   // The rest of your code goes here. For example:
  //   console.log("Found dog:", data);
  // });



//   logs.list({include_docs:true},function (err, data) {
//   console.log(err, data.rows);
// });


console.log('to location: ', payload.context['to_location']);

  var Loca = payload.context['to_location']
  console.log('Loca: ', Loca);

  if(Loca == null)
  {
    console.log("===== Error message ======= ");

  }

else
{
var cloudantquery = {
       "selector": {
      //   "request": {"$eq": Loca}

      "$or": [
              {
            "request": {"$eq": Loca}
              },
              {
            "requestTwo": {"$eq": Loca}
          },
          {
            "requestThree": {"$eq": Loca}
          },
          {
            "requestFour": {"$eq": Loca}
          },
          {
            "requestFive": {"$eq": Loca}
          },
          {
            "requestSix": {"$eq": Loca}
          },
          {
            "requestSeven": {"$eq": Loca}
          },
          {
            "requestEight": {"$eq": Loca}
          },
          {
            "requestNine": {"$eq": Loca}
          },
          {
            "requestTen": {"$eq": Loca}
          }

              ]



       },
       "fields": ["latitude","longitude","time"]
 };


 request({
        method: 'POST',
        uri: `https://${process.env.LOG_USER}:4165dbcde28365cebf76a90459f8851f13eba0af738b6b00adf01c8e6103c546@43b5605a-9f30-4037-93c5-457a642cf9b6-bluemix.cloudant.com/atmbranch/_find`,
        json: true,
        body: cloudantquery
  }, function (error, response, body) {

        if (!error && response.statusCode == 200) {
          console.log("data: ", body)

          if(body.docs[0]== null)
          {
            console.log("No data inside ")
              payload.context['N_Loca'] = "Apologies, currently we're not available at this location"
            //  payload.context['N_iframe'] = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


          }
        else{
        //  console.log("latitude: ",body.docs[0].latitude," , Longitude: ", body.docs[0].longitude, " , time: ", body.docs[0].time);

        //  payload.context['N_Loca'] = LocaN

//<iframe width="600" height="450" frameborder="0" style="border:0" src="https://www.google.com/maps/embed/v1/directions?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&origin=$to_location,Qatar&destination=$N_Location,Qatar&avoid=tolls|highways" allowfullscreen></iframe>
          const LocUrl =
            "https://maps.googleapis.com/maps/api/geocode/json?latlng="+body.docs[0].latitude+","+body.docs[0].longitude+"&key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ+";


const latit = body.docs[0].latitude;
const longit = body.docs[0].longitude

            payload.context['latitude'] = parseFloat(latit)
            payload.context['longitude'] = parseFloat(longit)


            const map_link = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


            const timeVariable = body.docs[0].time;


          request.get(LocUrl, (error, response, body) => {
              let json = JSON.parse(body);
             console.log('Location is at = ',json.results[0].address_components[0].long_name);
            // console.log(json.results[1].address_components[0].long_name);

             const LocaN ="Location: "+ json.results[0].formatted_address+ ", Time: "+ timeVariable

             payload.context['N_Loca'] = LocaN

             payload.context['N_Location'] = json.results[0].formatted_address
             payload.context['exact_loc'] = json.results[1].address_components[0].long_name


          //   payload.context['Long_Lat'] = json.results[0].address_components[0].long_name;

           });
}
        }
  });




  /////////////////////////////////BRANCH////////////////////////////////////

  request({
         method: 'POST',
         uri: `https://${process.env.LOG_USER}:4165dbcde28365cebf76a90459f8851f13eba0af738b6b00adf01c8e6103c546@43b5605a-9f30-4037-93c5-457a642cf9b6-bluemix.cloudant.com/branchloc/_find`,
         json: true,
         body: cloudantquery
   }, function (error, response, body) {

         if (!error && response.statusCode == 200) {
           console.log("data: ", body)

           if(body.docs[0]== null)
           {
             console.log("No data inside ")
               payload.context['brN_Loca'] = "Apologies, currently don't have an available branch at this location"
             //  payload.context['N_iframe'] = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


           }
         else{
         //  console.log("latitude: ",body.docs[0].latitude," , Longitude: ", body.docs[0].longitude, " , time: ", body.docs[0].time);

         //  payload.context['N_Loca'] = LocaN

  //<iframe width="600" height="450" frameborder="0" style="border:0" src="https://www.google.com/maps/embed/v1/directions?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&origin=$to_location,Qatar&destination=$N_Location,Qatar&avoid=tolls|highways" allowfullscreen></iframe>
           const LocUrl =
             "https://maps.googleapis.com/maps/api/geocode/json?latlng="+body.docs[0].latitude+","+body.docs[0].longitude+"&key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ+";


  const latit = body.docs[0].latitude;
  const longit = body.docs[0].longitude

             payload.context['brlatitude'] = parseFloat(latit)
             payload.context['brlongitude'] = parseFloat(longit)


             const map_link = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


             const timeVariable = body.docs[0].time;


           request.get(LocUrl, (error, response, body) => {
               let json = JSON.parse(body);
              console.log('Location is at = ',json.results[0].address_components[0].long_name);
             // console.log(json.results[1].address_components[0].long_name);

              const LocaN ="Location: "+ json.results[0].formatted_address+ ", Time: "+ timeVariable

              payload.context['brN_Loca'] = LocaN

              payload.context['brN_Location'] = json.results[0].formatted_address
              payload.context['brexact_loc'] = json.results[1].address_components[0].long_name


           //   payload.context['Long_Lat'] = json.results[0].address_components[0].long_name;

            });
  }
         }
   });





  /////////////////////////////////ARABIC////////////////////////////////////

  request({
         method: 'POST',
         uri: `https://${process.env.LOG_USER}:4165dbcde28365cebf76a90459f8851f13eba0af738b6b00adf01c8e6103c546@43b5605a-9f30-4037-93c5-457a642cf9b6-bluemix.cloudant.com/arabicbranch/_find`,
         json: true,
         body: cloudantquery
   }, function (error, response, body) {

         if (!error && response.statusCode == 200) {
           console.log("data: ", body)

           if(body.docs[0]== null)
           {
             console.log("No data inside ")
               payload.context['arN_Loca'] = "نعتذر ، نحن غير متاحين حاليًا في هذا الموقع"
             //  payload.context['N_iframe'] = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


           }
         else{
         //  console.log("latitude: ",body.docs[0].latitude," , Longitude: ", body.docs[0].longitude, " , time: ", body.docs[0].time);

         //  payload.context['N_Loca'] = LocaN

 //<iframe width="600" height="450" frameborder="0" style="border:0" src="https://www.google.com/maps/embed/v1/directions?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&origin=$to_location,Qatar&destination=$N_Location,Qatar&avoid=tolls|highways" allowfullscreen></iframe>
           const LocUrl =
             "https://maps.googleapis.com/maps/api/geocode/json?latlng="+body.docs[0].latitude+","+body.docs[0].longitude+"&key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ+";


 const latit = body.docs[0].latitude;
 const longit = body.docs[0].longitude

             payload.context['arlatitude'] = parseFloat(latit)
             payload.context['arlongitude'] = parseFloat(longit)


             const map_link = "https://www.google.com/maps/embed/v1/place?key=AIzaSyAqkf8A7DYeNWIZSozQkC5ZnyA5NeUVKlQ&q=Eiffel+Tower,Paris+France"


             const timeVariable = body.docs[0].time;


           request.get(LocUrl, (error, response, body) => {
               let json = JSON.parse(body);
              console.log('Location is at = ',json.results[0].address_components[0].long_name);
             // console.log(json.results[1].address_components[0].long_name);

              const LocaN ="موقع: "+ json.results[0].formatted_address+ ", زمن: "+ timeVariable

              payload.context['arN_Loca'] = LocaN

              payload.context['arN_Location'] = json.results[0].formatted_address
              payload.context['arexact_loc'] = json.results[1].address_components[0].long_name


           //   payload.context['Long_Lat'] = json.results[0].address_components[0].long_name;

            });
 }
         }
   });

}


                console.log("after insert")

              }


          console.log("there's input text")

const queryInput = JSON.stringify(payload.input);


            const context_input = JSON.stringify(payload.context);
            var str = queryInput;

            console.log("HANDLER DETECTED", str.includes('@'));

            var perpercentage = 0;
            var perpercentage2 = 0;





            var personalityInsightsPromise = new Promise(function(resolve, reject) {
              console.log("init personality insights")
                if (str.includes('@')) {
                    payload.context['handler'] = payload.input;
                    //console.log('******Handler****** ', payload.context['handler'].text);
                    const twitter_handler = "'" + payload.context['handler'] + "'";
                    client.get('statuses/user_timeline', {
                        screen_name: payload.context['handler'].text,
                        count: 2
                    }, function(error, tweets, response) {
                      //   console.log("$$$$$$$ TWEETS response $$$$$$$ ",response, '\n');

                        personality_insights.profile({
                                text: tweets,
                                language: 'en'
                            },
                            function(err, response) {
                                if (err)
                                    console.log('error:', err);
                                else
                                    //console.log(JSON.stringify(response, null, 2));
                                    //  const emotionTones = tone.document_tone.tone_categories[0].tones;
                                    console.log('apenness all ====== ', response.personality[0].name);
                                    console.log('adventurous all ====== ', response.personality[0].children[0].name);


                                perpercentage = response.personality[0].percentile * 100;
                                perpercentage2 = response.personality[0].children[0].percentile * 100;


                                console.log('personality percntage ====== ', perpercentage);
                                console.log('personality percntage ====== ', perpercentage2);


                                if(perpercentage > 60&& perpercentage2 > 10)
                                {
                                  if (workspaceID == '8a9ef81e-bd71-47fb-a83d-2da798842192')
                                  {
                                    payload.context['new_score'] = "Twitter أستطيع أن أرى أنك شخص مفتوح ومغامر من ملفك الشخصي على ";

                                  }
                                else if  (workspaceID == 'a72b3394-1fb1-43b2-9c34-7aad80bc754c')
                                {
                                    payload.context['new_score'] = "I can see you're an open and adventurous person from your Twitter profile";

                                }
                              }
                                else {
                                  payload.context['new_score'] = "I got your profile";

                                }



                                //console.log('Emotion ====== ', tone.document_tone.tone_categories[0].tones);
                                fs.writeFile("newresults.txt", JSON.stringify(response, null, 2), function(err) {
                                    if (err) {
                                        reject(err);
                                    }
                                    console.log("Results were saved!");
                                    resolve()
                                });





                            });
                    })
                }
                else {
                  console.log("No handler, resolving")
                  resolve();
                }
            });

            // var toneAnalyzerPromise = new Promise(function(resolve, reject){

            var percentage = 0
            var joy_percentage = 0
            var sad_percentage = 0


            var parameters = {}
            console.log('from currency: ', payload.context['from_currency']);
            console.log('to currency: ', payload.context['to_currency']);

              var c = payload.context['from_currency']
              var b = payload.context['to_currency']
              var stringN = "currency codes"
              var URL = 'https://www.exchangerate-api.com/supported-currencies';

              console.log('Click to return to ' + stringN.link(URL));

            const url =
            "https://v3.exchangerate-api.com/pair/925fdf1123b6751ee2f1b09f/"+ c+"/"+b;
            request.get(url, (error, response, body) => {
              let json = JSON.parse(body);
              console.log('Currancy: ', json.rate);
              const rateN = "Today's rate is: "+ json.rate;
              if(json.result =="error")
              {
              	  console.log("Undefined results found!");
                  payload.context['f_rate'] = "You entered the wrong currancy codes! https://www.exchangerate-api.com/supported-currencies to get the right codes";


              }

else
{
  payload.context['f_rate'] = rateN;

}


            });



  /////////////////////////////////////////




            var toneAnalyzerPromise = new Promise(function(resolve, reject) {
            toneAnalyzer.tone({
                    text: queryInput,
                    tones: 'emotion'
                },
                function(err, tone) {
                    let toneAngerScore = '';
                    if (err) {
                        console.log('Error occurred while invoking Tone analyzerrrr. ::', err);
                        reject(err)
                        // return res.status(err.code || 500).json(err);
                    } else {
                        const emotionTones = tone.document_tone.tone_categories[0].tones;
                        const emotionjoy = tone.document_tone.tone_categories[3];

                        console.log('Emotion joy ====== ', tone.document_tone.tone_categories[0].tones[3]);
                        console.log('Emotion joy score ====== ', tone.document_tone.tone_categories[0].tones[3].score);

                        console.log('Emotion sad ====== ', tone.document_tone.tone_categories[0].tones[4]);
                        console.log('Emotion sad score ====== ', tone.document_tone.tone_categories[0].tones[4].score);

                        console.log('Emotion anger ====== ', tone.document_tone.tone_categories[0].tones);

                        const len = emotionTones.length;
                        for (let i = 0; i < len; i++) {
                          //console.log('emotion = ', emotionTones[i].score * 100);
                      //    console.log('Emotion ====== ', tone.document_tone.tone_categories[i].tones);




                          // if (emotionTones[i].score * 100 < 60)
                          // {

                            percentage = emotionTones[i].score * 100;
                            joy_percentage = (tone.document_tone.tone_categories[0].tones[3].score)*100;
                            sad_percentage = (tone.document_tone.tone_categories[0].tones[4].score)*100;
                            var emotion_string = "i detected "+percentage+ " % anger, "+joy_percentage+ " % joy and "+sad_percentage+" % sadness"
                            //console.log('anger = ', emotionTones[i].score * 100);

                             console.log('emotion_anger score = ', 'Emotion_anger', emotionTones[i].score);
                             payload.context['emotion_score'] = emotion_string;

                          //  payload.context['emotion_score'] = "you're good";

                          //}
                          // else{
                          //   payload.context['emotion_score'] = "Do you want to talk to one of our representative to make your experience better? (yes/no)";
                          //
                          // }

                        //  console.log('NEW emotion_anger score = ', emotionTones[i].score*100);

                          if (emotionTones[i].score * 100 < 50)
                          {
                            percentage = emotionTones[i].score * 100;
                            //console.log('anger = ', emotionTones[i].score * 100);
                            console.log('emotion less than 20%');

                          //  payload.context['emotion_score'] = "you're good";
                            if (emotionTones[i].tone_id === 'anger') {
                                //console.log('Input = ', queryInput);
                                //  console.log('emotion_anger score = ', 'Emotion_anger', emotionTones[i].score);
                                toneAngerScore = emotionTones[i].score;
                                break;
                            }
                          }
                          else{
                            payload.context['emotion_angry'] = "Do you want to talk to one of our representative to make your experience better? (yes/no)";

                          }



                        }

                        payload.context['tone_anger_score'] = toneAngerScore;
                        //  tone_anger_score = toneAngerScore;
                        // console.log('input text payload = ', payload.input.text);
                        parameters = {
                            text: payload.input.text,
                            features: {

                                keywords: {
                                    emotion: true,
                                    sentiment: true,
                                    limit: 2
                                },
                                entities: {
                                    emotion: true,
                                    sentiment: true,
                                    limit: 2
                                }
                            }
                        };

                        // request.get(url, (error, response, body) => {
                        //     let json = JSON.parse(body);
                        //     console.log('Location is at = ',json.results[0].address_components[0].long_name);
                        //     payload.context['Long_Lat'] = json.results[0].address_components[0].long_name;
                        //
                        //   });

                        //payload.context['from_currency'] = payload.input;
                    //    console.log('from currency: ', payload.context['from_currency']);
                      //  var from_currency = payload.context['from_currency'].text;





                        nlu.analyze(parameters, function(err, response) {
                                    if (err) {
                                      console.log('error:', err);
                                    } else {
                                      const nluOutput = response;


                                      payload.context['nlu_output'] = nluOutput;
                                      // identify location
                                      const entities = nluOutput.entities;


                                    //  console.log('NLU = ',   response);
                                  //   payload.context['nlu_keyword'] = response.keywords[0].text;


                                      let location = entities.map(function(entry) {
                                        if (entry.type == 'Location') {

                                          return entry.text;
                                        }
                                      });
                                      location = location.filter(function(entry) {
                                        if (entry != null) {
                                          return entry;
                                        }
                                      });
                                      if (location.length > 0) {
                                        payload.context['Location'] = location[0];
                                        console.log('Location = ', payload.context['Location']);
                                      } else {
                                        payload.context['Location'] = '';
                        }
                                }




                        console.log("resolving tone")
                        resolve();

                        });
                    }
                  });
                });
                //
                // var nluPromise = new Promise(function(resolve, reject) {
                // nlu.analyze(parameters, function(err, response) {
                //   console.log('response === ', response);
                //
                //         if (err) {
                //             console.log('errorrr:', err);
                //             resolve();
                //         } else {
                //             const nluOutput = response;
                //             // identify location
                //             const entities = nluOutput.entities;
                //             console.log('Location = ', payload.context['Location']);
                //
                //             let location = entities.map(function(entry) {
                //                 payload.context['entries_output'] = entities[0];
                //                 if (entry.type == 'Location') {
                //                     return entry.text;
                //                 }
                //             });
                //             location = location.filter(function(entry) {
                //                 if (entry != null) {
                //                     return entry;
                //                 }
                //             });
                //             if (location.length > 0) {
                //                 payload.context['Location'] = location[0];
                //                 console.log('Location = ', payload.context['Location']);
                //                 resolve();
                //             } else {
                //                 payload.context['Location'] = '';
                //                 resolve();
                //             }
                //         }
                //         });
                //       })

                      Promise.all([personalityInsightsPromise, toneAnalyzerPromise])
                      .then(function(){
                        //console.log('personality score ====== ', payload.context['new_score']);
                      //  console.log('personality emotion ====== ', payload.context['emotion_score']);

                        conversation.message(payload, function(err, data) {
                            if (err) {
                                return res.status(err.code || 500).json(err);
                            } else {
                                // lookup actions
                                checkForLookupRequests(data, function(err, data) {
                                    if (err) {
                                        return res.status(err.code || 500).json(err);
                                    } else {
                                        return res.json(data);
                                    }
                                });
                            }
                        });
                      })
                      .catch(function(err){
                        console.log("Promise failed")
                        console.log(err)
                      })
                 }
                 else {
                   console.log("no input text")
                    conversation.message(payload, function(err, data) {
                        if (err) {
                            return res.status(err.code || 500).json(err);
                        } else {
                            //  console.log('conversation.message :: ', JSON.stringify(data));
                            return res.json(data);
                        }
                    });
                }
              //    workspaceID = 'a72b3394-1fb1-43b2-9c34-7aad80bc754c';


    }
});

/**
 *
 * Looks for actions requested by conversation service and provides the requested data.
 *
 **/
 function checkForLookupRequests(data, callback) {
   console.log('checkForLookupRequests');

   if (data.context && data.context.action && data.context.action.lookup && data.context.action.lookup != 'complete') {
     const payload = {
       workspace_id: workspaceID,
       context: data.context,
       input: data.input
     };

     // conversation requests a data lookup action


     console.log('************** before Discovery *************** InputText : ' + data.context.action.lookup);

      if (data.context.action.lookup === DISCOVERY_ACTION) {
       console.log('************** Discovery *************** InputText : ' + payload.input.text);
       let discoveryResponse = '';
       if (!discoveryParams) {
         console.log('Discovery is not ready for query.');
         discoveryResponse = 'Sorry, currently I do not have a response. Discovery initialization is in progress. Please try again later.';
         if (data.output.text) {
           data.output.text.push(discoveryResponse);
         }
         // Clear the context's action since the lookup and append was attempted.
         data.context.action = {};
         callback(null, data);
         // Clear the context's action since the lookup was attempted.
         payload.context.action = {};
       } else {
         const queryParams = {
           natural_language_query: payload.input.text,
           passages: true
         };
         Object.assign(queryParams, discoveryParams);
         discovery.query(queryParams, (err, searchResponse) => {
           discoveryResponse = 'Sorry, currently I do not have a response. Our Customer representative will get in touch with you shortly.';
           if (err) {
             console.error('Error searching for documents: ' + err);
           } else if (searchResponse.passages.length > 0) {
             const bestPassage = searchResponse.passages[0];
             console.log('Passage score: ', bestPassage.passage_score);
             console.log('Passage text: ', bestPassage.passage_text);

             // Trim the passage to try to get just the answer part of it.
             const lines = bestPassage.passage_text.split('\n');
             let bestLine;
             let questionFound = false;
             for (let i = 0, size = lines.length; i < size; i++) {
                const line = lines[i].trim();
               if (!line) {
                 continue; // skip empty/blank lines
               }
               if (line.includes('?') || line.includes('<h1')) {
                 // To get the answer we needed to know the Q/A format of the doc.
                 // Skip questions which either have a '?' or are a header '<h1'...
                 questionFound = true;
                 continue;
               }
               bestLine = line; // Best so far, but can be tail of earlier answer.
               if (questionFound && bestLine) {
                 // We found the first non-blank answer after the end of a question. Use it.
                 break;
               }
             }
             discoveryResponse =
               bestLine || 'Sorry I currently do not have an appropriate response for your query. Our customer care executive will call you in 24 hours.';
           }

           if (data.output.text) {
             data.output.text.push(discoveryResponse);
           }
           // Clear the context's action since the lookup and append was completed.
           data.context.action = {};
           callback(null, data);
           // Clear the context's action since the lookup was completed.
           payload.context.action = {};
         });
       }
     }
     else if (data.context.action.lookup === LOOKUP_BALANCE) {
       console.log('Lookup Balance requested');
       // if account type is specified (checking, savings or credit card)
       if (data.context.action.account_type && data.context.action.account_type != '') {
         // lookup account information services and update context with account data
         bankingServices.getAccountInfo(7829706, data.context.action.account_type, function(err, accounts) {
           if (err) {
             console.log('Error while calling bankingServices.getAccountInfo ', err);
             callback(err, null);
             return;
           }
           const len = accounts ? accounts.length : 0;

           const appendAccountResponse = data.context.action.append_response && data.context.action.append_response === true ? true : false;

           let accountsResultText = '';

           for (let i = 0; i < len; i++) {
             accounts[i].balance = accounts[i].balance ? numeral(accounts[i].balance).format('INR 0,0.00') : '';

             if (accounts[i].available_credit)
               accounts[i].available_credit = accounts[i].available_credit ? numeral(accounts[i].available_credit).format('INR 0,0.00') : '';

             if (accounts[i].last_statement_balance)
               accounts[i].last_statement_balance = accounts[i].last_statement_balance ? numeral(accounts[i].last_statement_balance).format('INR 0,0.00') : '';

             if (appendAccountResponse === true) {
               accountsResultText += accounts[i].number + ' ' + accounts[i].type + ' Balance: ' + accounts[i].balance + '<br/>';
             }
           }

           payload.context['accounts'] = accounts;

           // clear the context's action since the lookup was completed.
           payload.context.action = {};

           if (!appendAccountResponse) {
             console.log('call conversation.message with lookup results.');
             conversation.message(payload, function(err, data) {
               if (err) {
                 console.log('Error while calling conversation.message with lookup result', err);
                 callback(err, null);
               } else {
                 console.log('checkForLookupRequests conversation.message :: ', JSON.stringify(data));
                 callback(null, data);
               }
             });
           } else {
             console.log('append lookup results to the output.');
             // append accounts list text to response array
             if (data.output.text) {
               data.output.text.push(accountsResultText);
             }
             // clear the context's action since the lookup and append was completed.
             data.context.action = {};

             callback(null, data);
           }
         });
       }
     } else if (data.context.action.lookup === LOOKUP_TRANSACTIONS) {
       console.log('Lookup Transactions requested');
       bankingServices.getTransactions(7829706, data.context.action.category, function(err, transactionResponse) {
         if (err) {
           console.log('Error while calling account services for transactions', err);
           callback(err, null);
         } else {
           let responseTxtAppend = '';
           if (data.context.action.append_total && data.context.action.append_total === true) {
             responseTxtAppend += 'Total = <b>' + numeral(transactionResponse.total).format('INR 0,0.00') + '</b>';
           }

           if (transactionResponse.transactions && transactionResponse.transactions.length > 0) {
             // append transactions
             const len = transactionResponse.transactions.length;
             const sDt = new Date(data.context.action.startdt);
             const eDt = new Date(data.context.action.enddt);
             if (sDt && eDt) {
               for (let i = 0; i < len; i++) {
                 const transaction = transactionResponse.transactions[i];
                 const tDt = new Date(transaction.date);
                 if (tDt > sDt && tDt < eDt) {
                   if (data.context.action.append_response && data.context.action.append_response === true) {
                     responseTxtAppend +=
                       '<br/>' + transaction.date + ' &nbsp;' + numeral(transaction.amount).format('INR 0,0.00') + ' &nbsp;' + transaction.description;
                   }
                 }
               }
             } else {
               for (let i = 0; i < len; i++) {
                 const transaction1 = transactionResponse.transactions[i];
                 if (data.context.action.append_response && data.context.action.append_response === true) {
                   responseTxtAppend +=
                     '<br/>' + transaction1.date + ' &nbsp;' + numeral(transaction1.amount).format('INR 0,0.00') + ' &nbsp;' + transaction1.description;
                 }
               }
             }

             if (responseTxtAppend != '') {
               console.log('append lookup transaction results to the output.');
               if (data.output.text) {
                 data.output.text.push(responseTxtAppend);
               }
               // clear the context's action since the lookup and append was completed.
               data.context.action = {};
             }
             callback(null, data);

             // clear the context's action since the lookup was completed.
             payload.context.action = {};
             return;
           }
         }
       });
     } else if (data.context.action.lookup === LOOKUP_5TRANSACTIONS) {
       console.log('Lookup Transactions requested');
       bankingServices.getTransactions(7829706, data.context.action.category, function(err, transactionResponse) {
         if (err) {
           console.log('Error while calling account services for transactions', err);
           callback(err, null);
         } else {
           let responseTxtAppend = '';
           if (data.context.action.append_total && data.context.action.append_total === true) {
             responseTxtAppend += 'Total = <b>' + numeral(transactionResponse.total).format('INR 0,0.00') + '</b>';
           }

           transactionResponse.transactions.sort(function(a1, b1) {
             const a = new Date(a1.date);
             const b = new Date(b1.date);
             return a > b ? -1 : a < b ? 1 : 0;
           });

           if (transactionResponse.transactions && transactionResponse.transactions.length > 0) {
             // append transactions
             const len = 5; // transaction_response.transactions.length;
             for (let i = 0; i < len; i++) {
               const transaction = transactionResponse.transactions[i];
               if (data.context.action.append_response && data.context.action.append_response === true) {
                 responseTxtAppend +=
                   '<br/>' + transaction.date + ' &nbsp;' + numeral(transaction.amount).format('INR 0,0.00') + ' &nbsp;' + transaction.description;
               }
             }
           }
           if (responseTxtAppend != '') {
             console.log('append lookup transaction results to the output.');
             if (data.output.text) {
               data.output.text.push(responseTxtAppend);
             }
             // clear the context's action since the lookup and append was completed.
             data.context.action = {};
           }
           callback(null, data);

           // clear the context's action since the lookup was completed.
           payload.context.action = {};
           return;
         }
       });
     } else if (data.context.action.lookup === 'branch') {
       console.log('************** Branch details *************** InputText : ' + payload.input.text);

       const loc = data.context.action.Location.toLowerCase();
       bankingServices.getBranchInfo(loc, function(err, branchMaster) {
         if (err) {
           console.log('Error while calling bankingServices.getAccountInfo ', err);
           callback(err, null);
           return;
         }

         const appendBranchResponse = data.context.action.append_response && data.context.action.append_response === true ? true : false;

         let branchText = '';

         if (appendBranchResponse === true) {
           if (branchMaster != null) {
             branchText =
               'Here are the branch details at ' +
               branchMaster.location +
               ' <br/>Address: ' +
               branchMaster.address +
               '<br/>Phone: ' +
               branchMaster.phone +
               '<br/>Operation Hours: ' +
               branchMaster.hours +
               '<br/>';
            }
           else {
             branchText = "Sorry currently we don't have branch details for " + data.context.action.Location;
           }
         }

         payload.context['branch'] = branchMaster;

         // clear the context's action since the lookup was completed.
         payload.context.action = {};

         if (!appendBranchResponse) {
           console.log('call conversation.message with lookup results.');
           conversation.message(payload, function(err, data) {
             if (err) {
               console.log('Error while calling conversation.message with lookup result', err);
               callback(err, null);
             } else {
               console.log('checkForLookupRequests conversation.message :: ', JSON.stringify(data));
               callback(null, data);
             }
           });
         } else {
           console.log('append lookup results to the output.');
           // append accounts list text to response array
           if (data.output.text) {
             data.output.text.push(branchText);
           }
           // clear the context's action since the lookup and append was completed.
           data.context.action = {};

           callback(null, data);
         }
       });
     }  else {
       callback(null, data);
       return;
     }
   } else {
     callback(null, data);
     return;
   }
 }
 if (cloudantUrl) {
   // If logging has been enabled (as signalled by the presence of the
   // cloudantUrl) then the
   // app developer must also specify a LOG_USER and LOG_PASS env vars.
   if (!process.env.LOG_USER || !process.env.LOG_PASS) {
     throw new Error('LOG_USER OR LOG_PASS not defined, both required to enable logging!');
   }
   // add basic auth to the endpoints to retrieve the logs!
   var auth = basicAuth(process.env.LOG_USER, process.env.LOG_PASS);
   // If the cloudantUrl has been configured then we will want to set up a nano
   // client
   var nano = require('nano')(cloudantUrl);
   // add a new API which allows us to retrieve the logs (note this is not
   // secure)
   nano.db.get('atmbranch', function(err) {
     if (err) {
       console.error(err);
       nano.db.create('atmbranch', function(errCreate) {
         console.error(errCreate);
         logs = nano.db.use('atmbranch');
       });
     } else {
       logs = nano.db.use('atmbranch');
     }
   });

   // Endpoint which allows deletion of db
   app.post('/clearDb', auth, function(req, res) {
     nano.db.destroy('atmbranch', function() {
       nano.db.create('atmbranch', function() {
         logs = nano.db.use('atmbranch');
       });
     });
     return res.json({'message': 'Clearing db'});
   });

   // Endpoint which allows conversation logs to be fetched
   // csv - user input, conversation_id, timestamp

   // app.get('/chats', auth, function(req, res) {
   //   logs.list({
   //     include_docs: true,
   //     'descending': true
   //   }, function(err, body) {
   //     console.error(err);
   //     // download as CSV
   //     var csv = [];
   //     csv.push([
   //       'Id',
   //       'Question',
   //       'Intent',
   //       'Confidence',
   //       'Entity',
   //       'Emotion',
   //       'Output',
   //       'Time'
   //     ]);
   //     body.rows.sort(function(a, b) {
   //       if (a && b && a.doc && b.doc) {
   //         var date1 = new Date(a.doc.time);
   //         var date2 = new Date(b.doc.time);
   //         var t1 = date1.getTime();
   //         var t2 = date2.getTime();
   //         var aGreaterThanB = t1 > t2;
   //         var equal = t1 === t2;
   //         if (aGreaterThanB) {
   //           return 1;
   //         }
   //         return equal
   //           ? 0
   //           : -1;
   //       }
   //     });
   //     body.rows.forEach(function(row) {
   //       var question = '';
   //       var intent = '';
   //       var confidence = 0;
   //       var time = '';
   //       var entity = '';
   //       var outputText = '';
   //       var emotion = '';
   //       var id = '';
   //
   //       if (row.doc) {
   //         var doc = row.doc;
   //         if (doc.response.context) {
   //           id = doc.response.context.conversation_id;
   //         }
   //
   //         if (doc.response.context && doc.response.context.user) {
   //           emotion = doc.response.context.user.tone.emotion.current;
   //         }
   //
   //         if (doc.request && doc.request.input) {
   //           question = doc.request.input.text;
   //         }
   //         if (doc.response) {
   //           intent = '<no intent>';
   //           if (doc.response.intents && doc.response.intents.length > 0) {
   //             intent = doc.response.intents[0].intent;
   //             confidence = doc.response.intents[0].confidence;
   //           }
   //           entity = '<no entity>';
   //           if (doc.response.entities && doc.response.entities.length > 0) {
   //             entity = doc.response.entities[0].entity + ' : ' + doc.response.entities[0].value;
   //           }
   //           outputText = '<no dialog>';
   //           if (doc.response.output && doc.response.output.text) {
   //             outputText = doc.response.output.text.join(' ');
   //           }
   //         }
   //         time = new Date(doc.time).toLocaleString();
   //       }
   //       csv.push([
   //         id,
   //         question,
   //         intent,
   //         confidence,
   //         entity,
   //         emotion,
   //         outputText,
   //         time
   //       ]);
   //     });
   //     res.json(csv);
   //   });
   // });
 }

/**
 * Handle setup errors by logging and appending to the global error text.
 * @param {String} reason - The error message for the setup error.
 */
function handleSetupError(reason) {
    setupError += ' ' + reason;
    console.error('The app failed to initialize properly. Setup and restart needed.' + setupError);
    // We could allow our chatbot to run. It would just report the above error.
    // Or we can add the following 2 lines to abort on a setup error allowing Bluemix to restart it.
    console.error('\nAborting due to setup error!');
    process.exit(1);
}

module.exports = app;
