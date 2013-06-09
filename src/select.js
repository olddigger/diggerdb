/*

	(The MIT License)

	Copyright (C) 2005-2013 Kai Davenport

	Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

 */

/*
  Module dependencies.
*/

var _ = require('lodash'),
    async = require('async'),
    digger = require('digger.io');

/*

  we use these functions to map what comes out of the nested set supplier in digger

  each on does something like this:

  {
    field:'something',
    operator:'!=',
    value:10
  }

  into this:

  {
    something:{
      '$ne':10
    }
  }
  
*/

var operator_functions = {
  "=":function(query){
    var ret = {};
    ret[query.field] = query.value;
    return ret;
  },
  "!=":function(query){
    var ret = {};
    ret[query.field] = {
      '$ne':query.value
    }
    return ret;
  },
  ">":function(query){
    var ret = {};
    ret[query.field] = {
      '$gt':query.field==='_digger.left' ? query.value : parseFloat(query.value)
    }
    return ret;
  },
  ">=":function(query){
    var ret = {};
    ret[query.field] = {
      '$gte':query.field==='_digger.left' ? query.value : parseFloat(query.value)
    }
    return ret;
  },
  "<":function(query){
    var ret = {};
    ret[query.field] = {
      '$lt':query.field==='_digger.right' ? query.value : parseFloat(query.value)
    }
    return ret;
  },
  "<=":function(query){
    var ret = {};
    ret[query.field] = {
      '$lte':query.field==='_digger.right' ? query.value : parseFloat(query.value)
    }
    return ret;
  },
  "^=":function(fquery){
    var ret = {};
    ret[query.field] = new RegExp('^' + digger.utils.escapeRegexp(query.value), 'i');
    return ret;
  },
  "$=":function(query){
    var ret = {};
    ret[query.field] = new RegExp(digger.utils.escapeRegexp(query.value) + '$', 'i');
    return ret;
  },
  "~=":function(query){
    var ret = {};
    ret[query.field] = new RegExp('\\W' + digger.utils.escapeRegexp(query.value) + '\\W', 'i');      
    return ret;
  },
  "|=":function(query){
    var ret = {};
    ret[query.field] = new RegExp('^' + digger.utils.escapeRegexp(query.value) + '-', 'i');
    return ret;
  },
  "*=":function(query){
    var ret = {};
    ret[query.field] = new RegExp(digger.utils.escapeRegexp(query.value), 'i');
    return ret;
  }
}

function filterterm(term){
  return operator_functions[term.operator] ? true : false;
}

function processterm(term){
  if(_.isArray(term)){
    return {
      '$and':_.map(term, processterm)
    }
  }
  else{
    return operator_functions[term.operator].apply(null, [term]);  
  }
  
}

function extractskeleton(model){
  return model._digger;
}

module.exports = function select(collection_factory){

  return function(select_query, promise){

    /*
    
      this is the Nested Set supplier
      
    */
    var self = this;

    collection_factory(select_query.req, function(error, collection){


      /*
      
        filter out the bad operators then map the search into Mongo style
        
      */
      var search_terms = _.map(_.filter(select_query.query.search, filterterm), processterm);
      var skeleton_terms = _.map(select_query.query.skeleton, processterm);
      var selector = select_query.selector;
      var modifier = selector.modifier;

      var includedata = selector.modifier.laststep;
      var includechildren = includedata && selector.modifier.tree;

      if(search_terms.length<=0){
        promise.resolve([]);
        return;
      }

      if(skeleton_terms.length>0){
        search_terms.push({
          '$or':skeleton_terms
        })
      }

      var query = search_terms.length>1 ? {
        '$and':search_terms
      } : search_terms[0]

      var options = {};

      if(modifier.limit){
        options.limit = modifier.limit;
      }

      if(modifier.first){
        options.limit = 1;
      }

      var fields = includedata ? null : {
        "_digger":true
      }
    
      var cursor = collection.find(query, fields, options);

      cursor.toArray(function(error, results){
        if(error){
          promise.reject(error);
          return;
        }

        // here are the final results
        // check for a tree query to load all descendents also
        if(includechildren && results.length>0){

          // first lets map the results we have by id
          var results_map = {};

          _.each(results, function(result){
            results_map[result._digger.diggerid] = result;
          })

          // now build a descendent query based on the results
          var descendent_tree_query = self.generate_tree_query('', _.map(results, extractskeleton));
          descendent_tree_query = _.map(descendent_tree_query, processterm);

          var descendent_query = descendent_tree_query.length>1 ? 
            {'$or':descendent_tree_query} :
            {'$and':descendent_tree_query}

          var child_cursor = collection.find(descendent_query, null, {});

          child_cursor.toArray(function(error, descendent_results){

            if(error){
              promise.reject(error);
              return;
            }

            // loop each result and it's links to see if we have a parent in the original results
            // or in these results
            _.each(descendent_results, function(descendent_result){
              results_map[descendent_result._digger.diggerid] = descendent_result;
            })

            _.each(descendent_results, function(descendent_result){
              var parent = results_map[descendent_result._digger.diggerparentid];

              if(parent){
                parent._children = parent._children || [];
                parent._children.push(descendent_result);
              }
            })

            promise.resolve(results);
          })
        }
        else{
          promise.resolve(results);
        }      
      })
    })
  }
}